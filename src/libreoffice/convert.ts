import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const CONVERT_TIMEOUT_MS = 60000;

export class ConvertError extends Error {}
export class ConvertTimeoutError extends ConvertError {}

export type DocKind = "word" | "powerpoint" | "excel";

const EXPECTED_FILTER_PREFIX: Record<DocKind, string> = {
  word: "writer_",
  powerpoint: "impress_",
  excel: "calc_",
};

const KIND_DESCRIPTION: Record<DocKind, string> = {
  word: "Word document",
  powerpoint: "PowerPoint presentation",
  excel: "Excel workbook",
};

function describeKind(kind: DocKind): string {
  return KIND_DESCRIPTION[kind];
}

/**
 * Converts a single file to PDF via `soffice --headless --convert-to pdf`.
 * Each call is its own soffice process (see the earlier latency findings —
 * expect ~15-20s per call; there's no persistent-listener optimization here
 * yet). Returns the absolute path to the produced PDF.
 */
export async function convertToPdf(
  sofficePath: string,
  inputPath: string,
  cacheDir: string,
  kind: DocKind
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });

  // Unique per-conversion subdir: soffice names its output after the input
  // filename, and concurrent conversions of same-named files would collide.
  const jobDir = path.join(cacheDir, crypto.randomUUID());
  fs.mkdirSync(jobDir, { recursive: true });

  await runSoffice(sofficePath, inputPath, jobDir, kind);

  const expectedName = path.basename(inputPath, path.extname(inputPath)) + ".pdf";
  const outputPath = path.join(jobDir, expectedName);
  if (!fs.existsSync(outputPath)) {
    throw new ConvertError(`Conversion reported success but no PDF was found at ${outputPath}.`);
  }
  return outputPath;
}

// Excel sheets otherwise export using each sheet's print setup, which
// defaults to tiling the sheet across however many portrait 8.5x11 pages
// its content needs — awkward to read since one sheet becomes many
// disconnected pages. SinglePageSheets (LibreOffice 24.8+) instead sizes
// each sheet's single PDF page to fit all of that sheet's content, so one
// sheet tab always maps to exactly one page. Verified against a real
// wide/tall workbook: 9 tiled pages -> 2 whole-sheet pages, with the
// per-sheet outline/bookmarks (which sheet-tab navigation relies on)
// still intact and pointing at the right page.
const CONVERT_TO_TARGET: Record<DocKind, string> = {
  word: "pdf",
  powerpoint: "pdf",
  excel: 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}',
};

function runSoffice(sofficePath: string, inputPath: string, outDir: string, kind: DocKind): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      sofficePath,
      ["--headless", "--convert-to", CONVERT_TO_TARGET[kind], "--outdir", outDir, inputPath],
      { windowsHide: true }
    );

    const timer = window.setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ConvertTimeoutError(`Conversion timed out after ${CONVERT_TIMEOUT_MS / 1000}s.`));
    }, CONVERT_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("exit", (code) => {
      window.clearTimeout(timer);
      if (code !== 0) {
        reject(new ConvertError(`soffice exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      // LibreOffice can exit 0 while having silently used the WRONG import
      // filter for a malformed/misidentified file (confirmed earlier: a
      // non-pptx file got rendered through writer_pdf_Export as if it were
      // a Word doc, producing a plausible-looking but meaningless "success").
      // Reject unless the filter actually used matches the expected kind.
      const usedFilter = /using filter\s*:\s*(\S+)/.exec(stdout)?.[1];
      if (usedFilter && !usedFilter.startsWith(EXPECTED_FILTER_PREFIX[kind])) {
        reject(
          new ConvertError(
            `soffice used filter "${usedFilter}", not a ${kind} filter — this file likely isn't a valid ${describeKind(kind)}.`
          )
        );
        return;
      }
      resolve();
    });

    child.on("error", (err) => {
      window.clearTimeout(timer);
      reject(err);
    });
  });
}
