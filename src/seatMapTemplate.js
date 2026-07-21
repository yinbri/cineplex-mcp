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

const TEMPLATE = minifyStyleBlock(readFileSync(join(__dirname, "seatMapTemplate.html"), "utf8"));

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
