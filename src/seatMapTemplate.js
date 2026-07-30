/**
 * Loads the seat-map widget template (src/seatMapTemplate.html — the
 * pan/zoom auditorium UI with theatre tabs, showtime chips, and live filter
 * controls) and injects real tool data into it.
 *
 * This template is hand-built and already tested. buildSeatMapHtml() only
 * ever substitutes data into it — it never regenerates the HTML/CSS/JS, so
 * the UI Claude renders as an inline widget is the same known-good code every
 * time, not a fresh (and possibly buggy) generation per request.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PLACEHOLDER = "__CINEMA_DATA_JSON__";

// Minify only the CSS inside the single <style> block: strip comments,
// collapse whitespace, and tighten around structural punctuation. This is
// safe for this stylesheet (no whitespace-significant values) and shaves the
// shell without touching the JS — which we deliberately leave untouched, so
// the known-good, already-tested render code is byte-for-byte unchanged.
function minifyStyleBlock(html) {
  return html.replace(/<style>([\s\S]*?)<\/style>/, (_match, css) => {
    const min = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([{}:;,])\s*/g, "$1")
      .replace(/;}/g, "}")
      .trim();
    return "<style>" + min + "</style>";
  });
}

// Minify the widget's logic <script> to cut the tokens Claude must re-emit
// into show_widget (the dominant cost of rendering the widget). Conservative
// on purpose: strips full-line comments, blank lines, and per-line
// indentation, but KEEPS newlines so automatic-semicolon-insertion behaves
// exactly as before. Every template literal in this script holds HTML/SVG,
// where the trimmed leading whitespace is insignificant. The bare `<script>`
// match skips the JSON data island (it has attributes), so the placeholder is
// untouched.
function minifyScriptBlock(html) {
  return html.replace(/<script>([\s\S]*?)<\/script>/, (_match, js) => {
    const min = js
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"))
      .join("\n");
    return "<script>" + min + "</script>";
  });
}

const TEMPLATE = minifyScriptBlock(minifyStyleBlock(readFileSync(join(__dirname, "seatMapTemplate.html"), "utf8")));

// Exported for scripts/build-shell.mjs, which compiles this exact minified
// template into the CDN-hosted shell (dist/seatmap-shell.min.js) — one
// minification pipeline, no drift between inline and CDN builds.
export const MINIFIED_TEMPLATE = TEMPLATE;

// The jsDelivr tag the emitted widget wrapper points at. BUMP PROCEDURE
// (whenever seatMapTemplate.html changes): update this constant, run
// `npm run build:shell`, commit, `git tag <new version>`, push the tag.
// jsDelivr serves a tag with a 7-day client cache and no revalidation, so a
// new version = a new tag, never a force-push to an old one. Full checklist
// in RELEASING.md.
//
// You don't have to remember this: build-shell.mjs refuses to rebuild when
// the shell's content changed but this constant didn't, and `npm test` fails
// if dist/ is out of date with the template.
export const SHELL_VERSION = "widget-v1";
export const SHELL_CDN_URL =
  `https://cdn.jsdelivr.net/gh/yinbri/cineplex-mcp@${SHELL_VERSION}/dist/seatmap-shell.min.js`;

/**
 * @param {object} data Shape expected by seatMapTemplate.html's inline script:
 *   {
 *     movie: { name, runtimeInMinutes?, genres? },
 *     date: "YYYY-MM-DD",
 *     generatedAt: ISO timestamp string,
 *     defaultScoreOptions?: { excludeFrontRows, excludeSideSeats, minContiguous },
 *     theatres: [{
 *       id, name, address?, city?, province?, distanceKm?,
 *       sessions: [{
 *         showtimeId, startTime, format, auditorium, seatsRemaining, isSoldOut,
 *         totalColumns?, rawRows: [...], availability: { [seatId]: status },
 *       }],
 *     }],
 *   }
 * @returns {string} A complete, self-contained HTML document.
 */
export function buildSeatMapHtml(data) {
  // Escape `<` so a value containing "</script>" can't prematurely close the
  // data island; replacer is a function (not a string) so JSON content with
  // literal "$"-digit sequences is never treated as a replacement pattern.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return TEMPLATE.replace(DATA_PLACEHOLDER, () => json);
}

/**
 * Small widget wrapper: the per-request seat DATA plus one <script src>
 * pointing at the CDN-hosted shell (built from this same template by
 * scripts/build-shell.mjs). This is what the MCP tool returns — the shell
 * (CSS + render/pan/zoom/scoring JS, ~10k tokens) is identical on every
 * request, so shipping it from jsDelivr instead of inline cuts what the
 * model must re-emit into show_widget by ~3x, which is the dominant cost of
 * rendering the widget.
 *
 * jsDelivr (cdn.jsdelivr.net) is on the visualizer sandbox's CDN allowlist,
 * so the script tag loads inside the widget iframe. If the CDN ever fails,
 * the loading line below stays visible instead of a seat map — the
 * self-contained buildSeatMapHtml() above remains the no-dependency
 * fallback path.
 *
 * @param {object} data Same shape as buildSeatMapHtml.
 * @param {{ shellSrc?: string }} [opts] Override the shell URL (the local
 *   preview passes ./dist/seatmap-shell.min.js to test without the CDN).
 */
export function buildSeatMapWidget(data, { shellSrc = SHELL_CDN_URL } = {}) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return [
    `<script id="cinema-data" type="application/json">${json}</script>`,
    `<p id="cinema-loading" style="font-size:14px;color:#5f5e5a;padding:1rem 0;">Loading interactive seat map…</p>`,
    `<script src="${shellSrc}"></script>`,
  ].join("\n");
}

const SEAT_TYPE_CODE = { Wheelchair: "W", Companion: "C" };

/**
 * Compacts Cineplex's raw seat rows + availability map into the wire format
 * each session's `r` field carries. Lives here (next to buildSeatMapHtml, and
 * mirrored by the template's inflate()) so the server and any preview/test
 * harness share ONE implementation and can't drift apart.
 *
 * The seat-map widget embeds every seat inline, so for a multi-showtime IMAX
 * auditorium the naive JSON (~1000+ seats with full `id`s + a separate
 * availability map + long field names) balloons past the MCP tool-result token
 * cap — the model then never receives the HTML. This shrinks it ~7x by folding
 * availability into each seat, dropping the parallel map and the seat `id`s
 * that keyed it, encoding each seat as [column, label, open, typeCode?], and
 * omitting the type for ordinary "Standard" seats.
 *
 * @param {Array<{number:number,label:?string,seats:Array<{id:string,column:number,label:?string,type:string}>}>} rawRows
 * @param {Record<string,string>} availabilityMap  seatId -> status string
 * @returns {Array} rows as [rowNumber, rowLabel, [ [column, label, open, typeCode?], ... ]]
 */
export function compactRows(rawRows, availabilityMap) {
  return rawRows.map((row) => [
    row.number,
    row.label ?? null,
    row.seats.map((seat) => {
      const open = String(availabilityMap[seat.id] ?? "").toLowerCase() === "available" ? 1 : 0;
      const cell = [seat.column, seat.label ?? null, open];
      const code = SEAT_TYPE_CODE[seat.type];
      if (code) cell.push(code);
      return cell;
    }),
  ]);
}
