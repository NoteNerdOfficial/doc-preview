import * as fs from "fs";
import { readZipEntryUtf8 } from "./miniZip";

/**
 * Hidden Excel sheets still come out as pages in LibreOffice's headless PDF
 * export — confirmed against LibreOffice's own bug tracker as a known
 * command-line-vs-GUI discrepancy (GUI export skips hidden sheets, headless
 * `--convert-to` doesn't). A workbook with 6 visible + 18 hidden helper
 * sheets renders as 24 tabs instead of 6, most of them blank. Reads sheet
 * visibility straight from the workbook's own XML (name/state live in
 * xl/workbook.xml, per the OOXML spec) so the viewer can filter those pages
 * back out itself.
 *
 * Uses a small hand-rolled zip reader (miniZip.ts) rather than a general
 * zip library — a full library's IE-compatibility polyfills (dynamically
 * created <script> elements as a legacy task-scheduling trick, present in
 * both jszip's "lie" and "setimmediate" dependencies) got this plugin
 * flagged by Obsidian's community-plugin review for "code obfuscation",
 * even though neither ever sets `src` or executes anything — a review tool
 * false positive that's simplest to avoid entirely rather than fight.
 */
export async function getHiddenSheetNames(xlsxPath: string): Promise<Set<string>> {
  try {
    const data = fs.readFileSync(xlsxPath);
    const workbookXml = readZipEntryUtf8(data, "xl/workbook.xml");
    if (!workbookXml) return new Set();

    const hidden = new Set<string>();
    for (const tag of workbookXml.match(/<sheet\b[^>]*\/>/g) ?? []) {
      const state = /\bstate="([^"]*)"/.exec(tag)?.[1];
      if (state !== "hidden" && state !== "veryHidden") continue;
      const name = /\bname="([^"]*)"/.exec(tag)?.[1];
      if (name) hidden.add(unescapeXmlEntities(name));
    }
    return hidden;
  } catch (e) {
    console.warn(
      "Doc Preview: couldn't read sheet visibility from the workbook (hidden-sheet filtering unavailable for this file).",
      e
    );
    return new Set();
  }
}

function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
