import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask, TextLayer } from "pdfjs-dist";
import { setIcon } from "obsidian";
import * as fs from "fs";

// Injected at build time (esbuild.config.mjs) — the full source of
// pdfjs-dist's worker script. Embedded rather than shipped as a separate
// file: Obsidian's community-plugin installer only ever fetches
// main.js/manifest.json/styles.css from a release, never a 4th asset, so a
// standalone worker file 404s (net::ERR_FILE_NOT_FOUND) for anyone who
// installs normally instead of symlinking a local build.
declare const __PDF_WORKER_SOURCE__: string;

let workerConfigured = false;

/** Sets pdf.js's worker script location once per plugin lifetime, via a
 *  Blob URL built from the embedded source rather than a file path. */
export function configurePdfWorker(): void {
  if (workerConfigured) return;
  const blob = new Blob([__PDF_WORKER_SOURCE__], { type: "text/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  workerConfigured = true;
}

const ZOOM_STEP = 1.2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const INDICATOR_HIDE_DELAY_MS = 1500;

interface SaveDialogAPI {
  showSaveDialogSync(options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): string | undefined;
}
interface ElectronLike {
  remote?: { dialog: SaveDialogAPI };
  dialog?: SaveDialogAPI;
}

function pickSavePath(defaultPath: string): string | null {
  try {
    const nodeRequire = (window as unknown as { require: (moduleName: string) => ElectronLike }).require;
    const electron = nodeRequire("electron");
    const dialog = electron.remote?.dialog ?? electron.dialog;
    return dialog?.showSaveDialogSync({ defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] }) ?? null;
  } catch (e) {
    console.warn("Doc Preview: save dialog unavailable.", e);
    return null;
  }
}

/**
 * A self-contained PDF reader: canvas rendering (not the browser's built-in
 * PDF plugin — that one can't be restyled or partially hidden), zoom,
 * rotate, fit-to-page, a toggleable thumbnail rail, a fading page-number
 * indicator, and a download button. Mounts into a container element and
 * must be destroyed when the host view unloads/re-renders.
 */
export class PdfViewer {
  private doc: PDFDocumentProxy | null = null;
  private currentPage = 1;
  private totalPages = 0;
  private scale = 1;
  private fitToPage = true;
  private rotation = 0;
  private renderToken = 0;
  private activeRenderTask: RenderTask | null = null;

  private root: HTMLElement;
  private thumbRail: HTMLElement;
  private mainCol: HTMLElement;
  private canvasWrap: HTMLElement;
  private pageContainer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private textLayerDiv: HTMLElement;
  private activeTextLayer: TextLayer | null = null;
  private indicator: HTMLElement;
  private zoomLabel: HTMLElement;
  private thumbnailsBuilt = false;
  private thumbnailsVisible = false;

  private resizeObserver: ResizeObserver;
  private indicatorHideTimer: number | null = null;
  private sourcePdfPath = "";
  /** Per-page extracted text from the previously loaded document, used to
   *  detect which page changed on the next load() and jump there. Null
   *  until a document has been loaded once. */
  private pageSignatures: string[] | null = null;

  // Space+drag panning (the Figma/Photoshop "hand tool" convention) — a
  // distinct modifier so it never conflicts with the plain click-drag a user
  // expects for text selection. mousemove/mouseup are on window, not
  // canvasWrap, since a drag can move the pointer outside its bounds; those
  // need explicit removal in destroy(), unlike DOM-scoped listeners that go
  // away with the element.
  private isSpaceHeld = false;
  private isPanning = false;
  private panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
  private readonly boundOnMouseMove = (e: MouseEvent) => this.onMouseMove(e);
  private readonly boundOnMouseUp = () => this.onMouseUp();

  constructor(container: HTMLElement) {
    this.root = container.createDiv({ cls: "pdfviewer-root" });
    this.thumbRail = this.root.createDiv({ cls: "pdfviewer-thumbrail" });
    this.mainCol = this.root.createDiv({ cls: "pdfviewer-main" });

    this.buildToolbar(this.mainCol);

    this.canvasWrap = this.mainCol.createDiv({ cls: "pdfviewer-canvas-wrap" });
    this.canvasWrap.tabIndex = 0;
    // pageContainer shrink-wraps to the canvas's exact rendered size (not the
    // full flex-centered wrap), so the absolutely-positioned text layer
    // aligns pixel-for-pixel with the canvas regardless of centering.
    this.pageContainer = this.canvasWrap.createDiv({ cls: "pdfviewer-page" });
    this.canvas = this.pageContainer.createEl("canvas", { cls: "pdfviewer-canvas" });
    this.textLayerDiv = this.pageContainer.createDiv({ cls: "textLayer pdfviewer-text-layer" });
    this.indicator = this.canvasWrap.createDiv({ cls: "pdfviewer-page-indicator" });

    this.canvasWrap.addEventListener("keydown", (e) => this.onKeydown(e));
    this.canvasWrap.addEventListener("keyup", (e) => this.onKeyup(e));
    this.canvasWrap.addEventListener("mousemove", () => this.showIndicator());
    this.canvasWrap.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", this.boundOnMouseMove);
    window.addEventListener("mouseup", this.boundOnMouseUp);
    // Trackpad pinch-to-zoom (and ctrl+scroll-wheel on a mouse) arrives as a
    // wheel event with ctrlKey set — the standard convention Chromium/Safari/
    // Firefox all use to distinguish a zoom gesture from a plain scroll.
    // Must be non-passive to preventDefault() the browser's own page-zoom.
    this.canvasWrap.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitToPage) void this.renderCurrentPage();
    });
    this.resizeObserver.observe(this.canvasWrap);
  }

  /** Loads (or reloads, for the same instance, on refresh) a PDF. */
  async load(pdfPath: string): Promise<void> {
    this.sourcePdfPath = pdfPath;
    const data = fs.readFileSync(pdfPath);
    const newDoc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
    const newSignatures = await this.computePageSignatures(newDoc);
    const changedPage = this.findChangedPage(this.pageSignatures, newSignatures);

    const previousDoc = this.doc;
    this.doc = newDoc;
    this.pageSignatures = newSignatures;
    this.totalPages = newDoc.numPages;
    void previousDoc?.destroy();

    if (changedPage !== null) {
      this.currentPage = changedPage;
    } else if (this.currentPage > this.totalPages) {
      this.currentPage = this.totalPages; // deck shrank — clamp rather than error
    } else if (this.currentPage < 1) {
      this.currentPage = 1;
    }
    // else: same page, no detected change (or first load) — leave as-is.

    this.thumbnailsBuilt = false;
    this.thumbRail.empty();
    await this.renderCurrentPage();
    this.canvasWrap.focus();
    if (this.thumbnailsVisible) await this.buildThumbnails();
  }

  /** Cheap per-page change signal: extracted text, not a pixel render.
   *  Won't catch a purely visual edit with no text difference (e.g. only a
   *  fill color changed) — a deliberate cost/accuracy tradeoff, since
   *  rasterizing every page on every refresh to check would add real
   *  latency on top of the LibreOffice conversion step. */
  private async computePageSignatures(doc: PDFDocumentProxy): Promise<string[]> {
    const signatures: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      signatures.push(textContent.items.map((item) => ("str" in item ? item.str : "")).join(""));
    }
    return signatures;
  }

  /**
   * Positional diff, 1-indexed. Returns the first page whose text differs.
   * Returns null on first load (nothing to compare against), when nothing
   * textual differs, or when the page count itself changed — a shifted
   * page count makes positional comparison meaningless (page 5 in the old
   * doc isn't page 5 in the new one), and guessing wrong is worse than not
   * jumping at all.
   */
  private findChangedPage(oldSignatures: string[] | null, newSignatures: string[]): number | null {
    if (!oldSignatures || oldSignatures.length !== newSignatures.length) return null;
    for (let i = 0; i < newSignatures.length; i++) {
      if (oldSignatures[i] !== newSignatures[i]) return i + 1;
    }
    return null;
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.activeRenderTask?.cancel();
    this.activeTextLayer?.cancel();
    this.stopIndicatorTimer();
    window.removeEventListener("mousemove", this.boundOnMouseMove);
    window.removeEventListener("mouseup", this.boundOnMouseUp);
    void this.doc?.destroy();
    this.root.remove();
  }

  // ── Toolbar ────────────────────────────────────────────────────────────

  private buildToolbar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "pdfviewer-toolbar" });

    this.toolbarButton(bar, "panel-left", "Toggle thumbnails", () => this.toggleThumbnails());
    this.toolbarButton(bar, "chevron-left", "Previous page", () => this.goToPage(this.currentPage - 1));
    this.toolbarButton(bar, "chevron-right", "Next page", () => this.goToPage(this.currentPage + 1));

    bar.createDiv({ cls: "pdfviewer-toolbar-spacer" });

    this.toolbarButton(bar, "zoom-out", "Zoom out", () => this.zoomBy(1 / ZOOM_STEP));
    this.zoomLabel = bar.createSpan({ cls: "pdfviewer-zoom-label", text: "100%" });
    this.toolbarButton(bar, "zoom-in", "Zoom in", () => this.zoomBy(ZOOM_STEP));
    this.toolbarButton(bar, "maximize", "Fit to page", () => this.setFitToPage());
    this.toolbarButton(bar, "rotate-cw", "Rotate", () => this.rotate());

    bar.createDiv({ cls: "pdfviewer-toolbar-spacer" });

    this.toolbarButton(bar, "download", "Download PDF", () => this.download());
  }

  private toolbarButton(bar: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
    const btn = bar.createEl("button", {
      cls: "clickable-icon pdfviewer-toolbar-btn",
      attr: { "aria-label": tooltip, title: tooltip },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
  }

  private download(): void {
    const defaultName = "presentation.pdf";
    const target = pickSavePath(defaultName);
    if (!target) return;
    fs.copyFileSync(this.sourcePdfPath, target);
  }

  // ── Navigation / zoom / rotate ────────────────────────────────────────

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      this.goToPage(this.currentPage + 1);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      this.goToPage(this.currentPage - 1);
      e.preventDefault();
    } else if (e.code === "Space" && !this.isSpaceHeld) {
      this.isSpaceHeld = true;
      this.canvasWrap.addClass("is-pan-ready");
      e.preventDefault(); // stop Space from also scrolling/activating a focused button
    }
  }

  private onKeyup(e: KeyboardEvent): void {
    if (e.code === "Space") {
      this.isSpaceHeld = false;
      this.canvasWrap.removeClass("is-pan-ready");
    }
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      // Pinch gesture magnitude varies a lot between trackpads — exp() gives
      // smooth, proportional zoom (small pinch = small change) rather than a
      // fixed step per event, which would feel jumpy for fine gestures.
      e.preventDefault();
      this.fitToPage = false;
      const factor = Math.exp(-e.deltaY * 0.01);
      this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
      void this.renderCurrentPage();
    }
    this.showIndicator();
  }

  /** Space+drag panning (Figma/Photoshop's "hand tool" convention) — a
   *  distinct modifier from plain click-drag, which is reserved for text
   *  selection. Also the reliable path regardless of whether native
   *  scrolling of centered-and-overflowing flex content behaves correctly,
   *  which has historically been inconsistent across browser engines. */
  private onMouseDown(e: MouseEvent): void {
    if (!this.isSpaceHeld) return;
    this.isPanning = true;
    this.panStart = { x: e.clientX, y: e.clientY, scrollLeft: this.canvasWrap.scrollLeft, scrollTop: this.canvasWrap.scrollTop };
    this.canvasWrap.addClass("is-panning");
    e.preventDefault(); // stop native text-selection drag from starting underneath the pan
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isPanning) return;
    this.canvasWrap.scrollLeft = this.panStart.scrollLeft - (e.clientX - this.panStart.x);
    this.canvasWrap.scrollTop = this.panStart.scrollTop - (e.clientY - this.panStart.y);
  }

  private onMouseUp(): void {
    if (!this.isPanning) return;
    this.isPanning = false;
    this.canvasWrap.removeClass("is-panning");
  }

  private goToPage(pageNum: number): void {
    if (!this.doc || pageNum < 1 || pageNum > this.totalPages || pageNum === this.currentPage) return;
    this.currentPage = pageNum;
    void this.renderCurrentPage();
  }

  private zoomBy(factor: number): void {
    this.fitToPage = false;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    void this.renderCurrentPage();
  }

  private setFitToPage(): void {
    this.fitToPage = true;
    void this.renderCurrentPage();
  }

  private rotate(): void {
    this.rotation = (this.rotation + 90) % 360;
    void this.renderCurrentPage();
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private async renderCurrentPage(): Promise<void> {
    if (!this.doc) return;
    const token = ++this.renderToken;
    const page = await this.doc.getPage(this.currentPage);

    if (this.fitToPage) {
      this.scale = this.computeFitScale(page);
    }
    if (token !== this.renderToken) return;

    // Text layer shares this exact viewport (not a separately-computed one)
    // so its span positions line up pixel-for-pixel with the canvas.
    const viewport = page.getViewport({ scale: this.scale, rotation: this.rotation });
    await this.paint(page, this.canvas, viewport);
    if (token !== this.renderToken) return;

    this.pageContainer.style.width = `${viewport.width}px`;
    this.pageContainer.style.height = `${viewport.height}px`;
    await this.renderTextLayer(page, viewport);
    if (token !== this.renderToken) return;

    this.zoomLabel.setText(`${Math.round(this.scale * 100)}%`);
    this.showIndicator();
    this.indicator.setText(`${this.currentPage} / ${this.totalPages}`);
    this.updateActiveThumbnail();
  }

  private computeFitScale(page: PDFPageProxy): number {
    const unscaled = page.getViewport({ scale: 1, rotation: this.rotation });
    const wrapWidth = this.canvasWrap.clientWidth || unscaled.width;
    const wrapHeight = this.canvasWrap.clientHeight || unscaled.height;
    if (unscaled.width === 0 || unscaled.height === 0) return 1;
    return Math.min(wrapWidth / unscaled.width, wrapHeight / unscaled.height);
  }

  private async paint(page: PDFPageProxy, canvas: HTMLCanvasElement, viewport: PageViewport): Promise<void> {
    this.activeRenderTask?.cancel();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const task = page.render({ canvasContext: ctx, viewport });
    this.activeRenderTask = task;
    try {
      await task.promise;
    } catch (e) {
      // A cancelled render (e.g. rapid page/zoom changes) rejects — not a real error.
      if (!(e instanceof Error && e.name === "RenderingCancelledException")) throw e;
    } finally {
      if (this.activeRenderTask === task) this.activeRenderTask = null;
    }
  }

  /** Invisible, precisely-positioned text overlaid on the canvas — makes the
   *  rendered slide/page selectable and copyable even though what's actually
   *  visible is just pixels on a <canvas>. Thumbnails intentionally don't
   *  get one (selection there wouldn't mean anything at that size). */
  private async renderTextLayer(page: PDFPageProxy, viewport: PageViewport): Promise<void> {
    this.activeTextLayer?.cancel();
    this.textLayerDiv.empty();

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: this.textLayerDiv,
      viewport,
    });
    this.activeTextLayer = textLayer;
    try {
      await textLayer.render();
    } catch (e) {
      console.warn("Doc Preview: text layer render failed (text selection unavailable for this page).", e);
    } finally {
      if (this.activeTextLayer === textLayer) this.activeTextLayer = null;
    }
  }

  // ── Page indicator (fades in/out) ───────────────────────────────────────

  private showIndicator(): void {
    this.indicator.addClass("is-visible");
    this.stopIndicatorTimer();
    this.indicatorHideTimer = window.setTimeout(() => {
      this.indicator.removeClass("is-visible");
      this.indicatorHideTimer = null;
    }, INDICATOR_HIDE_DELAY_MS);
  }

  private stopIndicatorTimer(): void {
    if (this.indicatorHideTimer !== null) {
      window.clearTimeout(this.indicatorHideTimer);
      this.indicatorHideTimer = null;
    }
  }

  // ── Thumbnails ────────────────────────────────────────────────────────

  private toggleThumbnails(): void {
    this.thumbnailsVisible = !this.thumbnailsVisible;
    this.thumbRail.toggleClass("is-visible", this.thumbnailsVisible);
    if (this.thumbnailsVisible && !this.thumbnailsBuilt) void this.buildThumbnails();
  }

  private async buildThumbnails(): Promise<void> {
    if (!this.doc || this.thumbnailsBuilt) return;
    this.thumbnailsBuilt = true;
    for (let i = 1; i <= this.totalPages; i++) {
      const item = this.thumbRail.createDiv({ cls: "pdfviewer-thumb", attr: { "data-page": String(i) } });
      const canvas = item.createEl("canvas", { cls: "pdfviewer-thumb-canvas" });
      item.createDiv({ cls: "pdfviewer-thumb-label", text: String(i) });
      item.addEventListener("click", () => this.goToPage(i));

      const page = await this.doc.getPage(i);
      const unscaled = page.getViewport({ scale: 1 });
      const thumbScale = 120 / unscaled.width;
      await this.paint(page, canvas, page.getViewport({ scale: thumbScale, rotation: 0 }));
    }
    this.updateActiveThumbnail();
  }

  private updateActiveThumbnail(): void {
    for (const el of Array.from(this.thumbRail.children)) {
      el.toggleClass("is-active", el.getAttr("data-page") === String(this.currentPage));
    }
  }
}
