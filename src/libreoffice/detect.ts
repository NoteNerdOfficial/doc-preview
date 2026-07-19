import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LibreOfficeDetectionResult } from "../types";

/** Default OS locations LibreOffice normally installs to. */
function defaultCandidatePaths(): string[] {
  const platform = os.platform();

  if (platform === "darwin") {
    return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  }

  if (platform === "win32") {
    return [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
  }

  // linux
  return [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    ...globVersionedOptDirs("/opt"),
  ];
}

/** soffice's path relative to a LibreOffice *install root*, per platform. */
function sofficePathWithinInstallDir(installDir: string): string[] {
  const platform = os.platform();

  if (platform === "darwin") {
    return [path.join(installDir, "LibreOffice.app", "Contents", "MacOS", "soffice")];
  }

  if (platform === "win32") {
    return [path.join(installDir, "program", "soffice.exe")];
  }

  // linux: a dpkg-deb -x extraction nests under opt/libreoffice<version>/program/soffice
  return globVersionedOptDirs(path.join(installDir, "opt"));
}

function globVersionedOptDirs(optDir: string): string[] {
  try {
    return fs
      .readdirSync(optDir)
      .filter((name) => name.startsWith("libreoffice"))
      .map((name) => path.join(optDir, name, "program", "soffice"));
  } catch {
    return [];
  }
}

function readVersion(sofficePath: string): string | undefined {
  try {
    // e.g. "LibreOffice 26.2.4.2 40(Build:2)"
    const out = execFileSync(sofficePath, ["--version"], { timeout: 10000 }).toString();
    return out.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

/**
 * Looks for a usable soffice binary: first at the user's configured custom
 * install directory (if set), then at known OS default locations.
 */
export function detectLibreOffice(customInstallDir?: string): LibreOfficeDetectionResult {
  if (customInstallDir) {
    for (const candidate of sofficePathWithinInstallDir(customInstallDir)) {
      if (fs.existsSync(candidate)) {
        return { found: true, sofficePath: candidate, version: readVersion(candidate), source: "custom" };
      }
    }
  }

  for (const candidate of defaultCandidatePaths()) {
    if (fs.existsSync(candidate)) {
      return { found: true, sofficePath: candidate, version: readVersion(candidate), source: "default" };
    }
  }

  return { found: false };
}
