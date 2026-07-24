import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderSeatMapAscii } from "../src/seatMapAscii.js";

/**
 * Builds Cineplex-shaped raw { layout, availability } for a synthetic
 * auditorium: `rowCount` rows (A, B, C, ...), each with `seatsPerRow` seats in
 * columns 1..seatsPerRow, all "Available" and type "Standard" by default.
 * `overrides` maps "ROW-COLUMN" -> { status?, type? } to change a seat, or
 * null to remove it (an aisle gap). Seat ids are "ROW-COLUMN".
 */
function buildRaw(rowCount, seatsPerRow, overrides = {}) {
  const rows = [];
  const seatAvailabilities = {};
  for (let r = 0; r < rowCount; r++) {
    const label = String.fromCharCode(65 + r);
    const seats = [];
    for (let c = 1; c <= seatsPerRow; c++) {
      const key = `${label}-${c}`;
      const has = Object.prototype.hasOwnProperty.call(overrides, key);
      const ov = has ? overrides[key] : {};
      if (ov === null) continue; // gap
      const id = key;
      seats.push({ id, column: c, label: String(c), type: ov.type ?? "Standard" });
      seatAvailabilities[id] = ov.status ?? "Available";
    }
    rows.push({ number: r + 1, label, seats });
  }
  return { layout: { standardSeats: { rows } }, availability: { seatAvailabilities } };
}

const OPEN = "\u{1F7E9}"; // 🟩
const TAKEN = "\u{2B1B}"; // ⬛
const ACCESS = "\u{1F7EA}"; // 🟪
const PICK = "\u{1F7E6}"; // 🟦

describe("renderSeatMapAscii", () => {
  test("draws one glyph per seat with correct open/taken/accessible marks", () => {
    const raw = buildRaw(2, 3, {
      "A-2": { status: "Occupied" },
      "B-3": { type: "Wheelchair" },
    });
    const out = renderSeatMapAscii(raw, { partySize: 1, bestBlock: null });
    assert.ok(out.includes(`A  ${OPEN}${TAKEN}${OPEN}`), `row A wrong:\n${out}`);
    assert.ok(out.includes(`B  ${OPEN}${OPEN}${ACCESS}`), `row B wrong:\n${out}`);
    assert.ok(/SCREEN|ＳＣＲＥＥＮ/.test(out), "missing screen banner");
  });

  test("highlights the CENTER of the recommended block, sized to the party", () => {
    // 1 row, 7 seats all open; block is the whole row (start 1, length 7).
    const raw = buildRaw(1, 7);
    const out = renderSeatMapAscii(raw, {
      partySize: 2,
      bestBlock: { row: "A", startSeat: 1, length: 7 },
    });
    // Center 2 of a length-7 run starting at col 1: offset floor((7-2)/2)=2 -> cols 3,4.
    assert.ok(out.includes("Recommended: row A, seats 3–4 (2 together, center)"), `header wrong:\n${out}`);
    // Count picks within the seat row only (the legend line also names the pick glyph).
    const rowA = out.split("\n").find((l) => l.startsWith("A  "));
    assert.equal((rowA.match(new RegExp(PICK, "gu")) || []).length, 2, `pick count wrong:\n${out}`);
    assert.ok(rowA.includes(`${OPEN}${OPEN}${PICK}${PICK}${OPEN}${OPEN}`), `pick placement wrong:\n${out}`);
  });

  test("monochrome mode uses 1-cell glyphs and no emoji", () => {
    const raw = buildRaw(1, 3, { "A-1": { status: "Occupied" } });
    const out = renderSeatMapAscii(raw, {
      partySize: 1,
      monochrome: true,
      bestBlock: { row: "A", startSeat: 2, length: 2 },
    });
    assert.ok(!new RegExp(`${OPEN}|${TAKEN}|${PICK}|${ACCESS}`, "u").test(out), "monochrome output should contain no emoji");
    assert.ok(out.includes("▓"), "missing taken glyph (▓)");
    assert.ok(out.includes("★"), "missing recommended glyph (★)");
  });

  test("reports when no block fits the party", () => {
    const raw = buildRaw(1, 3);
    const out = renderSeatMapAscii(raw, { partySize: 4, bestBlock: null });
    assert.ok(out.includes("No block of 4 together"), `missing no-block message:\n${out}`);
  });

  test("appends the buy link as its own trailing line when provided", () => {
    const raw = buildRaw(1, 3);
    const url = "https://www.cineplex.com/ticketing/preview?theatreId=7402&showtimeId=1&dbox=false";
    const withUrl = renderSeatMapAscii(raw, { partySize: 1, buyUrl: url });
    const lines = withUrl.split("\n");
    assert.equal(lines[lines.length - 1], `🎟 Buy tickets: ${url}`, `buy line missing/misplaced:\n${withUrl}`);
    // Omitting buyUrl adds no buy line.
    const without = renderSeatMapAscii(raw, { partySize: 1 });
    assert.ok(!without.includes("Buy tickets"), "buy line should be absent when no url given");
  });

  test("empty layout degrades gracefully", () => {
    const out = renderSeatMapAscii({ layout: { standardSeats: { rows: [] } }, availability: {} }, {});
    assert.equal(out, "No seat data available to draw.");
  });
});
