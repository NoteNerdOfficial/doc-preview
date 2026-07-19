import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { setIcon } from "obsidian";
import * as fs from "fs";

let workerConfigured = false;

/** Sets pdf.js's worker script location once per plugin lifetime. */
export function configurePdfWorker(workerSrc: string): void {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
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
  private canvas: HTMLCanvasElement;
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

  constructor(container: HTMLElement) {
    this.root = container.createDiv({ cls: "pdfviewer-root" });
    this.thumbRail = this.root.createDiv({ cls: "pdfviewer-thumbrail" });
    this.mainCol = this.root.createDiv({ cls: "pdfviewer-main" });

    this.buildToolbar(this.mainCol);

    this.canvasWrap = this.mainCol.createDiv({ cls: "pdfviewer-canvas-wrap" });
    this.canvasWrap.tabIndex = 0;
    this.canvas = this.canvasWrap.createEl("canvas", { cls: "pdfviewer-canvas" });
    this.indicator = this.canvasWrap.createDiv({ cls: "pdfviewer-page-indicator" });

    this.canvasWrap.addEventListener("keydown", (e) => this.onKeydown(e));
    this.canvasWrap.addEventListener("mousemove", () => this.showIndicator());
    this.canvasWrap.addEventListener("wheel", () => this.showIndicator(), { passive: true });

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
    this.stopIndicatorTimer();
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
    }
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

    await this.paint(page, this.canvas, this.scale, this.rotation);
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

  private async paint(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number, rotation: number): Promise<void> {
    this.activeRenderTask?.cancel();
    const viewport = page.getViewport({ scale, rotation });
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
      await this.paint(page, canvas, thumbScale, 0);
    }
    this.updateActiveThumbnail();
  }

  private updateActiveThumbnail(): void {
    for (const el of Array.from(this.thumbRail.children)) {
      el.toggleClass("is-active", el.getAttr("data-page") === String(this.currentPage));
    }
  }
}
