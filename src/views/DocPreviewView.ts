import { FileSystemAdapter, FileView, TFile, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type DocPreviewPlugin from "../main";
import { detectLibreOffice } from "../libreoffice/detect";
import { convertToPdf, DocKind } from "../libreoffice/convert";
import { PdfViewer } from "../pdfviewer/PdfViewer";

export const VIEW_TYPE_DOC_PREVIEW = "doc-preview-view";

const AUTO_REFRESH_DEBOUNCE_MS = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < MS_PER_MINUTE) return "just now";
  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MINUTE);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diff / MS_PER_DAY);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export class DocPreviewView extends FileView {
  private plugin: DocPreviewPlugin;
  private loadingInterval: number | null = null;
  private lastJobDir: string | null = null;
  private renderToken = 0;
  private autoRefreshTimer: number | null = null;

  private headerEl: HTMLElement | null = null;
  private headerStatusEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private lastUpdatedAt: number | null = null;
  private headerErrorNote: string | null = null;
  private pdfViewer: PdfViewer | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DocPreviewPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DOC_PREVIEW;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Doc Preview";
  }

  getIcon(): string {
    return "file-text";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "pptx" || extension === "docx";
  }

  override async onOpen(): Promise<void> {
    // Added once per view instance (not per file load) — onLoadFile can fire
    // again if this leaf gets reused for a different file, and re-adding
    // here would stack duplicate buttons.
    this.addAction("refresh-cw", "Refresh preview", () => this.render());

    // A single long-lived listener, checked against whatever file is
    // currently open, rather than re-registering per file load (same
    // duplication risk as the action button otherwise).
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path !== this.file?.path) return;
        this.scheduleAutoRefresh();
      })
    );
  }

  override async onLoadFile(file: TFile): Promise<void> {
    // Genuinely new file in this leaf — nothing from a previous file's
    // shell/timestamp should carry over.
    this.lastUpdatedAt = null;
    this.headerErrorNote = null;
    this.destroyPdfViewer();
    this.headerEl = null;
    this.headerStatusEl = null;
    this.bodyEl = null;
    this.contentEl.empty();
    await this.render();
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    this.cancelAutoRefresh();
    this.stopLoadingTimer();
    this.destroyPdfViewer();
    this.cleanupLastJob();
    this.contentEl.empty();
  }

  override async onClose(): Promise<void> {
    this.cancelAutoRefresh();
    this.stopLoadingTimer();
    this.destroyPdfViewer();
  }

  private destroyPdfViewer(): void {
    this.pdfViewer?.destroy();
    this.pdfViewer = null;
  }

  /**
   * Debounced re-render on external file changes (e.g. Claude Code CLI
   * editing the file on disk). Debounced rather than firing on every
   * filesystem event because a full rewrite (the common pattern for
   * python-pptx-style tools) can emit several 'modify' events in quick
   * succession while only partially written — converting mid-write is
   * exactly the kind of corrupt/truncated input that produced the
   * "slide XML not found" failures earlier, so we wait for writes to go
   * quiet first rather than reacting to the first event.
   */
  private scheduleAutoRefresh(): void {
    this.cancelAutoRefresh();
    this.autoRefreshTimer = window.setTimeout(() => {
      this.autoRefreshTimer = null;
      void this.render();
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }

  private cancelAutoRefresh(): void {
    if (this.autoRefreshTimer !== null) {
      window.clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  private kindFor(file: TFile): DocKind {
    return file.extension === "docx" ? "word" : "powerpoint";
  }

  private cacheDir(): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return path.join(adapter.getBasePath(), this.app.vault.configDir, "plugins", this.plugin.manifest.id, "preview-cache");
  }

  private cleanupLastJob(): void {
    if (this.lastJobDir) {
      fs.rm(this.lastJobDir, { recursive: true, force: true }, () => {
        /* best effort */
      });
      this.lastJobDir = null;
    }
  }

  /** Creates the header/body shell once; returns it as-is on subsequent calls. */
  private ensureShell(): { header: HTMLElement; status: HTMLElement; body: HTMLElement } {
    if (!this.headerEl || !this.headerStatusEl || !this.bodyEl) {
      const container = this.contentEl;
      container.empty();
      container.addClass("doc-preview-container");
      this.headerEl = container.createDiv({ cls: "doc-preview-header" });
      this.headerStatusEl = this.headerEl.createSpan({ cls: "doc-preview-header-status" });
      this.bodyEl = container.createDiv({ cls: "doc-preview-body" });
    }
    return { header: this.headerEl, status: this.headerStatusEl, body: this.bodyEl };
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    if (!this.file) return;
    const kind = this.kindFor(this.file);
    const { body } = this.ensureShell();
    const isFirstRender = this.lastUpdatedAt === null;

    const detection = detectLibreOffice(this.plugin.settings.customInstallDir || undefined);
    if (!detection.found || !detection.sofficePath) {
      const msg = "LibreOffice wasn't found. Install it (or point to an existing install) from Settings → Doc Preview.";
      if (isFirstRender) this.renderFullMessage(body, msg, true);
      else this.setHeaderStatus(msg, true);
      return;
    }

    if (isFirstRender) this.renderFullLoading(body);
    else this.setHeaderStatus("Refreshing…", false);

    try {
      const adapter = this.app.vault.adapter as FileSystemAdapter;
      const absoluteInputPath = adapter.getFullPath(this.file.path);
      const pdfPath = await convertToPdf(detection.sofficePath, absoluteInputPath, this.cacheDir(), kind);

      // A slower/stale render finishing after a newer one started would
      // otherwise clobber it — only the latest render token may paint.
      if (token !== this.renderToken) return;

      this.cleanupLastJob();
      this.lastJobDir = path.dirname(pdfPath);
      this.lastUpdatedAt = Date.now();
      this.headerErrorNote = null;
      await this.renderPdf(body, pdfPath);
      this.updateHeaderStatus();
    } catch (e) {
      if (token !== this.renderToken) return;
      console.error("Doc Preview: conversion failed", e);
      const message = e instanceof Error ? e.message : String(e);
      if (isFirstRender) {
        // Nothing successful to fall back to — this is all the user sees.
        this.renderFullMessage(body, message, true);
      } else {
        // Keep the last good preview on screen; report the failure inline
        // instead of blanking a perfectly good render over a transient error
        // (e.g. auto-refresh catching a file mid-write).
        this.headerErrorNote = `Refresh failed: ${message}`;
        this.updateHeaderStatus();
      }
    }
  }

  private setHeaderStatus(text: string, isError: boolean): void {
    if (!this.headerStatusEl) return;
    this.headerStatusEl.setText(text);
    this.headerStatusEl.toggleClass("is-error", isError);
  }

  /**
   * Computed fresh each time this is called — not on a ticking interval.
   * Continuous per-second updates were the earlier complaint; this only
   * changes when a render actually happens (load/refresh), so the wording
   * can go a bit stale between refreshes rather than visibly counting up.
   */
  private updateHeaderStatus(): void {
    if (!this.headerStatusEl || this.lastUpdatedAt === null) return;
    if (this.headerErrorNote) {
      this.headerStatusEl.setText(
        `${this.headerErrorNote} · showing preview from ${formatRelativeTime(this.lastUpdatedAt)}`
      );
      this.headerStatusEl.addClass("is-error");
    } else {
      this.headerStatusEl.setText(`Last updated ${formatRelativeTime(this.lastUpdatedAt)}`);
      this.headerStatusEl.removeClass("is-error");
    }
  }

  private renderFullLoading(body: HTMLElement): void {
    this.stopLoadingTimer();
    body.empty();

    const wrap = body.createDiv({ cls: "doc-preview-status" });
    wrap.createDiv({ cls: "doc-preview-spinner" });
    const label = wrap.createDiv({ cls: "doc-preview-status-text", text: "Rendering preview… 0s" });

    const start = Date.now();
    this.loadingInterval = window.setInterval(() => {
      const elapsed = Math.round((Date.now() - start) / 1000);
      label.setText(`Rendering preview… ${elapsed}s`);
    }, 1000);
  }

  private stopLoadingTimer(): void {
    if (this.loadingInterval !== null) {
      window.clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
  }

  private renderFullMessage(body: HTMLElement, message: string, isError: boolean): void {
    this.stopLoadingTimer();
    body.empty();
    const wrap = body.createDiv({ cls: "doc-preview-status" });
    wrap.createDiv({
      cls: isError ? "doc-preview-status-text doc-preview-error" : "doc-preview-status-text",
      text: message,
    });
  }

  private async renderPdf(body: HTMLElement, pdfPath: string): Promise<void> {
    this.stopLoadingTimer();
    // Reused across refreshes (not recreated) so it can remember the
    // previous document's page signatures to jump to whatever changed, and
    // so zoom/rotation/thumbnail-panel state survive a refresh instead of
    // resetting every time.
    if (!this.pdfViewer) {
      body.empty();
      this.pdfViewer = new PdfViewer(body);
    }
    // PdfViewer reads the file's raw bytes itself (fs.readFileSync) rather
    // than loading it by URL — sidesteps the file:// restriction entirely
    // (confirmed earlier: "Not allowed to load local resource" when the
    // previous iframe-based approach tried to navigate to a file:// URL).
    await this.pdfViewer.load(pdfPath);
  }
}
