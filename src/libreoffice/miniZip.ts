import * as zlib from "zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** ZIP comment field is at most 65535 bytes — the EOCD record can't be
 *  further from EOF than that plus its own fixed size. */
const MAX_EOCD_SEARCH = 65535 + EOCD_MIN_SIZE;

/**
 * Reads one named file out of a plain (non-zip64, non-encrypted) ZIP archive
 * — enough to pull `xl/workbook.xml` out of an .xlsx without a general-
 * purpose zip dependency. xlsx files are always small, standard,
 * non-encrypted zips (Excel/LibreOffice never produce zip64 ones — that
 * needs >65535 entries or a >4GB member), so the simplifications here are
 * safe for real workbooks; anything unexpected just returns null and the
 * caller falls back to treating no sheets as hidden.
 */
export function readZipEntryUtf8(buffer: Buffer, entryPath: string): string | null {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) return null;

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) return null; // zip64 — unsupported, not expected for .xlsx

  let cursor = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) return null;

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (name === entryPath) {
      return extractEntry(buffer, localHeaderOffset, compressionMethod, compressedSize);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function extractEntry(buffer: Buffer, localHeaderOffset: number, compressionMethod: number, compressedSize: number): string | null {
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) return null;
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return compressed.toString("utf8"); // stored, no compression
  if (compressionMethod === 8) return zlib.inflateRawSync(compressed).toString("utf8"); // deflate
  return null; // unsupported method — not expected for .xlsx
}
