import { App, ButtonComponent, Notice, PluginSettingTab, requireApiVersion, Setting, SettingDefinitionItem } from "obsidian";
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

  /**
   * getSettingDefinitions() only exists from Obsidian 1.13.0 (Catalyst
   * early-access as of this writing — not yet on general release, where the
   * latest stable is 1.12.7). display() is kept as a real, fully-working
   * fallback for that mainstream case, not a token stub — both paths call
   * the exact same render* helpers below, so there's one implementation of
   * the actual settings, just two ways of mounting it depending on which
   * API the running Obsidian version actually has.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "LibreOffice",
        render: (setting) => this.renderHeading(setting),
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
        render: (setting) => this.renderInstallButton(setting),
      },
    ];
  }

  /** Fallback for Obsidian < 1.13.0 — i.e. still the mainstream case. Not
   *  called at all on 1.13.0+ (Obsidian renders from getSettingDefinitions
   *  instead whenever that returns a non-empty array). */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderHeading(new Setting(containerEl));
    this.renderStatus(new Setting(containerEl));
    this.renderInstallLocation(new Setting(containerEl));
    this.renderInstallButton(new Setting(containerEl));
  }

  /** Re-renders whichever of getSettingDefinitions/display is actually
   *  active. `update` only exists on 1.13.0+; calling the wrong one risks
   *  fighting the declarative renderer's own bookkeeping on newer Obsidian,
   *  or crashing outright on older Obsidian where update() doesn't exist —
   *  requireApiVersion is the sanctioned guard for exactly this. */
  private refresh(): void {
    if (requireApiVersion("1.13.0")) {
      this.update();
    } else {
      this.display();
    }
  }

  private renderHeading(setting: Setting): void {
    setting
      .setHeading()
      .setName("LibreOffice")
      .setDesc(
        "Previews are rendered locally via LibreOffice, run headless (no window ever opens). " +
          "If you already have LibreOffice installed, it'll be detected automatically below. " +
          "Otherwise you can install a copy to a folder of your choosing — it does not have to go " +
          "into Applications / Program Files."
      );
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
        .onClick(() => this.refresh())
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
            this.refresh();
          } else {
            new Notice("Couldn't open a folder picker on this system — type the path manually instead.");
          }
        })
      );
  }

  private renderInstallButton(setting: Setting): void {
    const desc = createFragment();
    desc.append(
      "Downloads the official build from documentfoundation.org and installs it into the folder above. " +
        "Large download (several hundred MB) — this can take a few minutes. Some networks (corporate " +
        "proxies/firewalls) block this — if it fails, "
    );
    desc.createEl("a", {
      text: "download LibreOffice yourself",
      href: "https://www.libreoffice.org/download/download-libreoffice/",
    });
    desc.append(
      " and install it normally. You don't need to fill in Install location above for that — " +
        "a normal install to the default Applications/Program Files location is detected automatically."
    );

    setting
      .setName("Install LibreOffice")
      .setDesc(desc)
      .addButton((btn) =>
        btn
          .setCta()
          .setButtonText("Install")
          .onClick(() => this.runInstall(btn))
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
      this.refresh();
    } catch (e) {
      console.error("Doc Preview: LibreOffice install failed", e);
      new Notice(
        `Install failed: ${e instanceof Error ? e.message : String(e)}\n\nYou can also download LibreOffice yourself from libreoffice.org and install it normally — it'll be detected automatically.`,
        10000
      );
      btn.setButtonText("Install");
      btn.setDisabled(false);
    }
  }
}
