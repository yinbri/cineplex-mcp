/**
 * Renders a Cineplex seat map as a compact, chat-friendly ASCII/emoji diagram —
 * the lightweight text sibling of seatMapTemplate.js's interactive HTML widget.
 *
 * This exists for the same reason the HTML renderer does: so Claude never
 * hand-draws seat-map art per request (inconsistent alignment, wrong glyphs,
 * invented seats). The MCP tool calls this once and returns the finished text
 * for Claude to paste verbatim into a fenced code block.
 *
 * Two glyph sets:
 *   - color (default): 🟩 open  ⬛ taken  🟪 accessible  🟦 recommended
 *     Squares tile edge-to-edge for a real seat-grid look; a U+3000 ideographic
 *     space (2 cells wide, matching emoji advance) fills aisle gaps so columns
 *     stay aligned.
 *   - monochrome: ·/▓/+/★ — 1-cell glyphs that align in any terminal/font,
 *     for surfaces where emoji width drifts.
 *
 * Pure and network-free: it takes Cineplex's raw seat-layout + availability
 * (the same shape getRawSeatMap returns) plus a precomputed bestBlock from
 * seatScoring.js, and returns a string. All scoring stays in seatScoring.js.
 */

import { bySeatNumber } from "./seatScoring.js";

const FULL_WIDTH_SPACE = "　"; // 2-cell blank; matches emoji cell advance
const SCREEN_FULL_WIDTH = "ＳＣＲＥＥＮ"; // "ＳＣＲＥＥＮ"
const ACCESSIBLE_TYPES = new Set(["Wheelchair", "Companion"]);
const LABEL_WIDTH = 3; // row-label column, e.g. "A  " / "AA "

const GLYPHS = {
  color: { open: "🟩", taken: "⬛", accessible: "🟪", pick: "🟦", gap: FULL_WIDTH_SPACE },
  mono: { open: "·", taken: "▓", accessible: "+", pick: "★", gap: " " },
};

/**
 * Flattens Cineplex's raw layout + availability into rows of
 * { column, accessible, available }, dropping empty (aisle/gap) rows so the
 * picture matches what seatScoring.js scored (which drops them too).
 */
function buildRows(layout, availability) {
  const statuses = availability?.seatAvailabilities ?? {};
  const rawRows = layout?.standardSeats?.rows ?? [];
  return rawRows
    .filter((r) => Array.isArray(r.seats) && r.seats.length > 0)
    .map((r) => ({
      label: String(r.label ?? r.number ?? ""),
      seats: r.seats.map((s) => ({
        column: Number(s.column),
        // The printed seat identifier ("A26"), which is NOT the column — see
        // normalizeCineplexSeatMap. Used for the recommendation line so it
        // names the seats you'd actually ask for.
        label: s.label ?? null,
        accessible: ACCESSIBLE_TYPES.has(s.type),
        available: String(statuses[s.id] ?? "").toLowerCase() === "available",
      })),
    }));
}

/**
 * From seatScoring's bestBlock ({ row, startSeat, length }), pick the seats to
 * highlight: the CENTER `partySize` seats of the block (so a couple gets the
 * middle two, not the whole empty row). Returns a Set of "label:column" keys.
 */
function pickRecommended(rows, bestBlock, partySize) {
  const picks = new Set();
  if (!bestBlock) return picks;
  const row = rows.find((r) => r.label === bestBlock.row);
  if (!row) return picks;
  const sorted = [...row.seats].sort((a, b) => a.column - b.column);
  const idx = sorted.findIndex((s) => s.column === bestBlock.startSeat);
  if (idx === -1) return picks;
  const len = bestBlock.length;
  const take = Math.max(1, Math.min(partySize, len));
  const offset = Math.floor((len - take) / 2); // center the pick within the run
  for (let i = 0; i < take && idx + offset + i < sorted.length; i++) {
    picks.add(row.label + ":" + sorted[idx + offset + i].column);
  }
  return picks;
}

/**
 * @param {{ layout: object, availability: object }} raw  As from getRawSeatMap.
 * @param {{
 *   bestBlock?: { row: string, startSeat: number, length: number } | null,
 *   partySize?: number,
 *   monochrome?: boolean,
 *   theatreName?: string,
 *   showLabel?: string,
 * }} [options]
 * @returns {string} The finished diagram (header + centered screen + grid + legend).
 */
export function renderSeatMapAscii({ layout, availability } = {}, options = {}) {
  const {
    bestBlock = null,
    partySize = 2,
    monochrome = false,
    theatreName = "",
    showLabel = "",
    buyUrl = "",
  } = options;

  const g = monochrome ? GLYPHS.mono : GLYPHS.color;
  const rows = buildRows(layout, availability);
  if (rows.length === 0) return "No seat data available to draw.";

  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    for (const s of r.seats) {
      if (s.column < min) min = s.column;
      if (s.column > max) max = s.column;
    }
  }
  const cols = max - min + 1;
  const picks = pickRecommended(rows, bestBlock, partySize);

  const lines = [];

  // Header
  const title = [theatreName, showLabel].filter(Boolean).join(" · ");
  if (title) lines.push(title);
  if (picks.size > 0) {
    // Prefer the printed seat labels; fall back to columns when the layout
    // carries no labels (e.g. a synthetic map).
    const picked = rows
      .flatMap((r) => r.seats.map((s) => ({ ...s, row: r.label })))
      .filter((s) => picks.has(s.row + ":" + s.column));
    const labels = picked.every((s) => s.label != null)
      ? picked.map((s) => s.label).sort(bySeatNumber)
      : picked.map((s) => String(s.column)).sort(bySeatNumber);
    lines.push(
      `Recommended: row ${bestBlock.row}, seats ${labels[0]}–${labels[labels.length - 1]} (${labels.length} together, center)`
    );
  } else {
    lines.push(`No block of ${partySize} together in the preferred zone — showing full availability.`);
  }
  lines.push("");

  // Centered SCREEN banner. Label spans 6 seat-cells in both modes (6 full-width
  // chars in color, 6 normal chars in mono); pad with gap units to center it.
  const label = monochrome ? "SCREEN" : SCREEN_FULL_WIDTH;
  const padUnits = Math.max(0, Math.floor((cols - 6) / 2));
  lines.push(" ".repeat(LABEL_WIDTH) + g.gap.repeat(padUnits) + label);

  // Seat grid, front-to-back
  for (const r of rows) {
    const byCol = new Map(r.seats.map((s) => [s.column, s]));
    let line = "";
    for (let c = min; c <= max; c++) {
      const s = byCol.get(c);
      if (!s) line += g.gap;
      else if (picks.has(r.label + ":" + c)) line += g.pick;
      else if (!s.available) line += g.taken;
      else if (s.accessible) line += g.accessible;
      else line += g.open;
    }
    lines.push(r.label.padEnd(LABEL_WIDTH) + line);
  }

  // Legend
  lines.push("");
  lines.push(`${g.open} open   ${g.taken} taken   ${g.pick} your seats   ${g.accessible} accessible`);

  // Buy link. Emitted on its own trailing line (not woven into the grid) so the
  // caller can lift it OUT of the code fence and render it as a real clickable
  // Markdown link — links inside a ``` block don't linkify. See the tool
  // description in index.js.
  if (buyUrl) {
    lines.push("");
    lines.push(`🎟 Buy tickets: ${buyUrl}`);
  }

  return lines.join("\n");
}

/** Marker lines that fence off the copy-me payload in the tool result. */
export const COPY_START = "===== COPY EVERYTHING BELOW THIS LINE INTO YOUR REPLY =====";
export const COPY_END = "===== COPY EVERYTHING ABOVE THIS LINE =====";

/**
 * Wraps a rendered diagram into the exact Markdown the assistant should paste
 * into its reply, and fences it with COPY_START/COPY_END markers.
 *
 * Assembling this server-side (rather than describing it in the tool
 * description and hoping) is deliberate: the client collapses tool results
 * behind a "tools used" disclosure, so the diagram only reaches the user if the
 * assistant reproduces it. The less reassembly that step requires, the more
 * often it survives — so the code fence is already applied, and the buy link is
 * already lifted out of the fence as a Markdown link (links don't linkify
 * inside ```). The assistant's whole job becomes copy-paste.
 *
 * @param {string} diagram Output of renderSeatMapAscii.
 * @returns {string} Marker-fenced, ready-to-paste Markdown.
 */
export function toPastableReply(diagram) {
  const lines = String(diagram).split("\n");

  // Lift the trailing "🎟 Buy tickets: <url>" line (and the blank line before
  // it) out of the diagram so it can live outside the code fence.
  let buyLine = "";
  const last = lines[lines.length - 1] ?? "";
  const match = /^🎟 Buy tickets: (\S+)$/.exec(last);
  if (match) {
    lines.pop();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    buyLine = `🎟 [Buy tickets](${match[1]})`;
  }

  const parts = ["```", lines.join("\n"), "```"];
  if (buyLine) parts.push("", buyLine);

  return [COPY_START, ...parts, COPY_END].join("\n");
}
