import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

const STABLE_INDEX_URL = "https://download.documentfoundation.org/libreoffice/stable/";

export interface InstallProgress {
  phase: "resolving" | "downloading" | "installing" | "done";
  /** 0-1, only meaningful during the "downloading" phase. */
  fraction?: number;
  message?: string;
}

export type ProgressCallback = (progress: InstallProgress) => void;

/** Fetches the stable release index and returns the newest version string, e.g. "26.2.4". */
async function getLatestVersion(): Promise<string> {
  const html = await httpGetText(STABLE_INDEX_URL);
  const versions = Array.from(html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)).map((m) => m[1]);
  if (versions.length === 0) throw new Error("Could not find any LibreOffice versions in the release index.");
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function httpGetText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(httpGetText(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function downloadFile(url: string, destPath: string, onProgress?: ProgressCallback): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        return;
      }

      const total = Number(res.headers["content-length"] ?? 0);
      let received = 0;
      const file = fs.createWriteStream(destPath);

      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) onProgress?.({ phase: "downloading", fraction: received / total });
      });

      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

function macArch(): "aarch64" | "x86_64" {
  return os.arch() === "arm64" ? "aarch64" : "x86_64";
}

/**
 * Downloads and installs LibreOffice into `installDir` (a directory the user
 * chose — does not have to be /Applications, Program Files, etc).
 *
 * Confidence per platform:
 *   - macOS: tested end-to-end (mount dmg, copy .app, verify it runs from the new location).
 *   - Windows: implemented per LibreOffice's documented MSI INSTALLLOCATION
 *     property, but NOT verified on real Windows — there's no Windows machine
 *     in this dev loop. Test before relying on it; watch specifically for
 *     whether msiexec still triggers a UAC prompt even when installDir is
 *     fully user-owned (registry/Start Menu writes may still require it).
 *   - Linux: extracts the .deb with `dpkg-deb -x` (no root needed), but this
 *     only unpacks files — it does NOT resolve LibreOffice's shared-library
 *     dependencies the way `apt install` would. May fail to run on a system
 *     missing those libs. Least-tested path of the three.
 */
export async function installLibreOffice(installDir: string, onProgress?: ProgressCallback): Promise<string> {
  onProgress?.({ phase: "resolving", message: "Checking latest LibreOffice version…" });
  const version = await getLatestVersion();
  fs.mkdirSync(installDir, { recursive: true });

  const platform = os.platform();
  if (platform === "darwin") return installMac(version, installDir, onProgress);
  if (platform === "win32") return installWindows(version, installDir, onProgress);
  return installLinux(version, installDir, onProgress);
}

async function installMac(version: string, installDir: string, onProgress?: ProgressCallback): Promise<string> {
  const arch = macArch();
  const fileName = `LibreOffice_${version}_MacOS_${arch}.dmg`;
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/mac/${arch}/${fileName}`;
  const dmgPath = path.join(os.tmpdir(), fileName);

  await downloadFile(url, dmgPath, onProgress);

  onProgress?.({ phase: "installing", message: "Mounting disk image…" });
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "lo-mount-"));
  execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-mountpoint", mountPoint]);

  try {
    const appNameInDmg = fs.readdirSync(mountPoint).find((n) => n.endsWith(".app"));
    if (!appNameInDmg) throw new Error("No .app bundle found inside the downloaded disk image.");

    onProgress?.({ phase: "installing", message: `Copying to ${installDir}…` });
    const destApp = path.join(installDir, "LibreOffice.app");
    fs.rmSync(destApp, { recursive: true, force: true });
    // ditto (not cp/fs.cpSync) — preserves resource forks/xattrs that a plain
    // recursive copy can drop, which matters for signed .app bundles.
    execFileSync("ditto", [path.join(mountPoint, appNameInDmg), destApp]);

    onProgress?.({ phase: "done" });
    return path.join(destApp, "Contents", "MacOS", "soffice");
  } finally {
    execFileSync("hdiutil", ["detach", mountPoint, "-quiet"]);
    fs.rmSync(dmgPath, { force: true });
  }
}

async function installWindows(version: string, installDir: string, onProgress?: ProgressCallback): Promise<string> {
  const fileName = `LibreOffice_${version}_Win_x86-64.msi`;
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/${fileName}`;
  const msiPath = path.join(os.tmpdir(), fileName);

  await downloadFile(url, msiPath, onProgress);

  onProgress?.({ phase: "installing", message: "Running installer…" });
  // NOT VERIFIED on real Windows. INSTALLLOCATION is LibreOffice's documented
  // property for a custom install path; a UAC prompt may still appear for the
  // registry/shortcut writes even though the files land in a user-owned folder.
  execFileSync("msiexec.exe", [
    "/i", msiPath,
    "/quiet", "/qn", "/norestart",
    `INSTALLLOCATION=${installDir}`,
  ]);

  fs.rmSync(msiPath, { force: true });
  onProgress?.({ phase: "done" });
  return path.join(installDir, "program", "soffice.exe");
}

async function installLinux(version: string, installDir: string, onProgress?: ProgressCallback): Promise<string> {
  const fileName = `LibreOffice_${version}_Linux_x86-64_deb.tar.gz`;
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/deb/x86_64/${fileName}`;
  const tarPath = path.join(os.tmpdir(), fileName);

  await downloadFile(url, tarPath, onProgress);

  onProgress?.({ phase: "installing", message: "Extracting package…" });
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-extract-"));
  execFileSync("tar", ["-xzf", tarPath, "-C", extractDir]);

  // NOT VERIFIED — internal layout of the deb tarball (DEBS/*.deb) is based on
  // LibreOffice's documented convention, not confirmed against a real download.
  // dpkg-deb -x also does not resolve shared-library dependencies; a system
  // missing those libs may still fail to run the extracted soffice binary.
  const debsDir = findDir(extractDir, "DEBS");
  if (!debsDir) throw new Error("Could not find the DEBS directory inside the downloaded archive.");

  const mainDeb = fs.readdirSync(debsDir).find((f) => f.startsWith("libreoffice") && f.endsWith(".deb") && !f.includes("-l10n-") && !f.includes("-help-"));
  if (!mainDeb) throw new Error("Could not find the main LibreOffice .deb inside the downloaded archive.");

  for (const deb of fs.readdirSync(debsDir).filter((f) => f.endsWith(".deb"))) {
    execFileSync("dpkg-deb", ["-x", path.join(debsDir, deb), installDir]);
  }

  fs.rmSync(tarPath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  onProgress?.({ phase: "done" });
  const sofficeCandidates = fs
    .readdirSync(path.join(installDir, "opt"))
    .filter((n) => n.startsWith("libreoffice"))
    .map((n) => path.join(installDir, "opt", n, "program", "soffice"));
  return sofficeCandidates[0] ?? "";
}

function findDir(root: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === name) return full;
    const nested = findDir(full, name);
    if (nested) return nested;
  }
  return undefined;
}
