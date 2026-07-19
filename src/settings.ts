import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type DocPreviewPlugin from "./main";
import { detectLibreOffice } from "./libreoffice/detect";
import { installLibreOffice } from "./libreoffice/install";
import * as os from "os";
import * as path from "path";

interface ElectronDialogAPI {
  showOpenDialogSync(options: { properties: string[]; defaultPath?: string }): string[] | undefined;
}

interface ElectronLike {
  remote?: { dialog: ElectronDialogAPI };
  dialog?: ElectronDialogAPI;
}

/** Opens a native folder-picker dialog. Falls back to null if Electron's
 *  remote dialog isn't available (varies by Obsidian/Electron version) —
 *  the text field next to the Browse button is always there as a fallback. */
function pickFolder(defaultPath?: string): string | null {
  try {
    const nodeRequire = (window as unknown as { require: (moduleName: string) => ElectronLike }).require;
    const electron = nodeRequire("electron");
    const dialog = electron.remote?.dialog ?? electron.dialog;
    const result = dialog?.showOpenDialogSync({
      properties: ["openDirectory", "createDirectory"],
      defaultPath,
    });
    return result?.[0] ?? null;
  } catch (e) {
    console.warn("Doc Preview: folder picker unavailable, falling back to manual path entry.", e);
    return null;
  }
}

function defaultSuggestedDir(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "DocPreview", "LibreOffice");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "DocPreview", "LibreOffice");
  }
  return path.join(os.homedir(), ".local", "share", "doc-preview", "libreoffice");
}

export class DocPreviewSettingTab extends PluginSettingTab {
  plugin: DocPreviewPlugin;

  constructor(app: App, plugin: DocPreviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Everything below uses render-type definitions rather than the native
  // control/action shapes: the folder picker needs a text field + custom
  // Electron dialog button in the same row, and the status/install rows need
  // to recompute their own text on each render — neither fits the
  // declarative control schema cleanly, and `render` is the documented
  // escape hatch for exactly this (it still gets name/desc search indexing
  // from the definition object, which is the actual thing this migration
  // is for).
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "LibreOffice",
        render: (setting) => {
          setting
            .setHeading()
            .setDesc(
              "Previews are rendered locally via LibreOffice, run headless (no window ever opens). " +
                "If you already have LibreOffice installed, it'll be detected automatically below. " +
                "Otherwise you can install a copy to a folder of your choosing — it does not have to go " +
                "into Applications / Program Files."
            );
        },
      },
      {
        name: "Detected installation",
        render: (setting) => this.renderStatus(setting),
      },
      {
        name: "Install location",
        desc: "Where to install LibreOffice if you use the Install button below. You can pick any folder you have write access to.",
        render: (setting) => this.renderInstallLocation(setting),
      },
      {
        name: "Install LibreOffice",
        desc:
          "Downloads the official build from documentfoundation.org and installs it into the folder above. " +
          "Large download (several hundred MB) — this can take a few minutes.",
        render: (setting) => {
          setting.addButton((btn) =>
            btn
              .setCta()
              .setButtonText("Install")
              .onClick(() => this.runInstall(btn))
          );
        },
      },
    ];
  }

  private renderStatus(setting: Setting): void {
    const detection = detectLibreOffice(this.plugin.settings.customInstallDir || undefined);

    setting.setName("Detected installation");
    if (detection.found) {
      setting.setDesc(
        `${detection.version ?? "LibreOffice"} — ${detection.sofficePath} (${
          detection.source === "custom" ? "your configured folder" : "default system location"
        })`
      );
    } else {
      setting.setDesc("Not found in the configured folder or default system locations.");
    }
    setting.addExtraButton((btn) =>
      btn
        .setIcon("refresh-cw")
        .setTooltip("Re-check")
        .onClick(() => this.update())
    );
  }

  private renderInstallLocation(setting: Setting): void {
    setting
      .setName("Install location")
      .setDesc("Where to install LibreOffice if you use the Install button below. You can pick any folder you have write access to.")
      .addText((text) => {
        text
          .setPlaceholder(defaultSuggestedDir())
          .setValue(this.plugin.settings.customInstallDir)
          .onChange(async (value) => {
            this.plugin.settings.customInstallDir = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass("doc-preview-path-input");
      })
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(async () => {
          const chosen = pickFolder(this.plugin.settings.customInstallDir || defaultSuggestedDir());
          if (chosen) {
            this.plugin.settings.customInstallDir = chosen;
            await this.plugin.saveSettings();
            this.update();
          } else {
            new Notice("Couldn't open a folder picker on this system — type the path manually instead.");
          }
        })
      );
  }

  private async runInstall(btn: ButtonComponent): Promise<void> {
    const installDir = this.plugin.settings.customInstallDir || defaultSuggestedDir();
    if (!this.plugin.settings.customInstallDir) {
      this.plugin.settings.customInstallDir = installDir;
      await this.plugin.saveSettings();
    }

    btn.setDisabled(true);
    try {
      await installLibreOffice(installDir, (progress) => {
        if (progress.phase === "downloading" && progress.fraction !== undefined) {
          btn.setButtonText(`Downloading… ${Math.round(progress.fraction * 100)}%`);
        } else if (progress.message) {
          btn.setButtonText(progress.message);
        }
      });
      new Notice("LibreOffice installed successfully.");
      this.update();
    } catch (e) {
      console.error("Doc Preview: LibreOffice install failed", e);
      new Notice(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.setButtonText("Install");
      btn.setDisabled(false);
    }
  }
}
