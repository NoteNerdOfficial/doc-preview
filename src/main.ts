import { Notice, Plugin } from "obsidian";
import { DocPreviewSettingTab } from "./settings";
import { DEFAULT_SETTINGS, DocPreviewSettings } from "./types";
import { DocPreviewView, VIEW_TYPE_DOC_PREVIEW } from "./views/DocPreviewView";
import { configurePdfWorker } from "./pdfviewer/PdfViewer";

const HANDLED_EXTENSIONS = ["pptx", "docx", "xlsx"];

export default class DocPreviewPlugin extends Plugin {
  settings: DocPreviewSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DocPreviewSettingTab(this.app, this));

    // Once per plugin lifetime — GlobalWorkerOptions is a pdf.js module-level
    // singleton. Built from an embedded source string (see PdfViewer.ts),
    // not a separate file — Obsidian's installer never fetches a 4th asset.
    configurePdfWorker();

    this.registerView(VIEW_TYPE_DOC_PREVIEW, (leaf) => new DocPreviewView(leaf, this));

    // Each extension is registered independently — if another installed
    // plugin already owns one (e.g. a Word-only viewer), that extension is
    // skipped rather than failing the whole plugin.
    for (const ext of HANDLED_EXTENSIONS) {
      try {
        this.registerExtensions([ext], VIEW_TYPE_DOC_PREVIEW);
      } catch (e) {
        console.warn(`Doc Preview: couldn't register .${ext} (likely already owned by another plugin).`, e);
        new Notice(`Doc Preview: .${ext} files are already handled by another plugin, skipping.`);
      }
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<DocPreviewSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
