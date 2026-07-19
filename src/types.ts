export interface DocPreviewSettings {
  /** Custom LibreOffice install directory chosen by the user, if any. */
  customInstallDir: string;
  /** Directory the plugin should install into by default, offered as the pre-filled suggestion. */
  suggestedInstallDir: string;
}

export const DEFAULT_SETTINGS: DocPreviewSettings = {
  customInstallDir: "",
  suggestedInstallDir: "",
};

export interface LibreOfficeDetectionResult {
  found: boolean;
  sofficePath?: string;
  version?: string;
  /** Where it was found: a known OS default location, or the user's custom install dir. */
  source?: "default" | "custom";
}
