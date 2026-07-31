#!/usr/bin/env node
/**
 * Regenerates `src/data/postalCodes.json` from GeoNames' Canadian postal-code
 * dump (https://download.geonames.org/export/zip/CA.zip).
 *
 *   npm run build:locations
 *
 * One table comes out of it:
 *
 *   "M5B" -> [lat, lon]     (all 1652 forward sortation areas)
 *
 * Postal codes are the one location input a language model cannot be trusted
 * to convert. Measured on 2026-07-31, Claude's own recall placed 12 of 16
 * sampled FSAs within 10 km — but attributed T9K to Cold Lake when it is
 * Fort McMurray, a 264 km error stated with exactly the same confidence as
 * the ones it got right. Recall has no error bar; a lookup table does.
 *
 * City names deliberately are NOT built here. A model converts "Toronto" or
 * "Halifax" to coordinates accurately and knows when it cannot, so bundling a
 * city gazetteer duplicated work the caller already does well. Cities that
 * have a Cineplex theatre still resolve — from Cineplex's own theatre
 * directory at runtime, which costs no data file and is grounded in real
 * theatre locations.
 *
 * FSA-level precision is all this server needs: the output is "theatres within
 * N km", defaulting to 50, so resolving to the right neighbourhood and
 * resolving to the exact doorstep produce the same answer.
 *
 * Data: GeoNames postal codes, CC BY 4.0 — https://www.geonames.org/
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "postalCodes.json");
const SOURCE_URL = "https://download.geonames.org/export/zip/CA.zip";

// ---------------------------------------------------------------------------
// Minimal ZIP reader — avoids adding a dependency just to unpack one file.
// Reads the central directory (which always carries the entry sizes) rather
// than trusting local headers, whose size fields are zero when the archive was
// written with a streaming data descriptor.
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(buf) {
  // The EOCD record is last, but a trailing comment can follow it, so scan back.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Not a ZIP archive: no end-of-central-directory record found");
}

function unzipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP: bad central-directory signature at entry ${i}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);

    // Re-read the local header to find where the payload actually starts; its
    // extra field can differ in length from the central directory's.
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ---------------------------------------------------------------------------

const round = (n) => Math.round(n * 10000) / 10000; // ~11 m; far finer than needed

async function main() {
  console.log(`Downloading ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`  ${zip.length} bytes`);

  const entries = unzipEntries(zip);
  const txt = entries.get("CA.txt");
  if (!txt) throw new Error(`CA.txt not in archive (found: ${[...entries.keys()].join(", ")})`);

  const fsa = {};
  let rows = 0;
  for (const line of txt.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    // country, postalCode, placeName, admin1Name, admin1Code, admin2Name,
    // admin2Code, admin3Name, admin3Code, latitude, longitude, accuracy
    const postalCode = f[1];
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!postalCode || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows++;

    const code = postalCode.toUpperCase().slice(0, 3);
    if (!fsa[code]) fsa[code] = [round(lat), round(lon)];
  }

  const payload = {
    _source: "GeoNames postal codes (CC BY 4.0) — https://www.geonames.org/",
    _generated: new Date().toISOString().slice(0, 10),
    _note: "Regenerate with: npm run build:locations",
    fsa,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload) + "\n", "utf8");

  const { size } = await import("node:fs").then((m) => m.promises.stat(OUT_PATH));
  // Canada Post's own convention: a "0" in the second position marks a rural
  // FSA. Those cover enormous areas — X0A spans the eastern Arctic — so the
  // resolver reports them at region precision rather than as located points.
  const rural = Object.keys(fsa).filter((c) => c[1] === "0").length;
  console.log(`Parsed ${rows} postal rows`);
  console.log(`  ${Object.keys(fsa).length} FSAs (${rural} rural, reported as region precision)`);
  console.log(`Wrote ${OUT_PATH} (${Math.round(size / 1024)} KB)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
