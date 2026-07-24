/**
 * Local preview harness for the seat-map widget.
 *
 * The widget template ships with a data placeholder that only gets filled at
 * request time by the MCP server, so there's nothing to look at while editing
 * it. This script fills it with REAL Cineplex data (captured once to a
 * fixture, then reused offline) and writes a standalone preview.html you can
 * open in any browser.
 *
 *   npm run preview            build preview.html from the cached fixture
 *                              (fetches once if the fixture is missing)
 *   npm run preview -- --refresh   re-fetch live data, then build
 *   npm run preview:watch      rebuild instantly whenever the template changes
 *
 * Open the printed file:// path in your browser and just refresh after edits
 * (in --watch mode it's rebuilt for you; hit reload). It uses live data but
 * never restarts or touches the MCP server, so the loop is fast.
 *
 * Fixture + output are git-ignored; override the target with env vars:
 *   PREVIEW_THEATRE_ID (default 7123, Winston Churchill Oakville)
 *   PREVIEW_MOVIE      (default "The Odyssey")
 *   PREVIEW_DATE       (default: 3 days out, YYYY-MM-DD)
 *   PREVIEW_FORMAT     (default "IMAX")
 */
import { readFileSync, writeFileSync, existsSync, watch, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getShowtimes, findMovieByTitle, getRawSeatMap } from "../src/cineplexClient.js";
import { buildSeatMapHtml, buildSeatMapWidget, compactRows } from "../src/seatMapTemplate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURE = join(__dirname, ".preview-fixture.json");
const OUT = join(ROOT, "preview.html");

const THEATRE_ID = process.env.PREVIEW_THEATRE_ID ?? "7123";
const MOVIE = process.env.PREVIEW_MOVIE ?? "The Odyssey";
const FORMAT = process.env.PREVIEW_FORMAT ?? "IMAX";
const DATE = process.env.PREVIEW_DATE ?? new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

const watchMode = process.argv.includes("--watch");
const refresh = process.argv.includes("--refresh");
// --cdn: emit the same tiny data+<script src> wrapper the MCP tool returns,
// pointed at the LOCAL dist/seatmap-shell.min.js (built by build-shell.mjs)
// so the CDN-mode widget can be validated end-to-end before pushing a tag.
const cdnMode = process.argv.includes("--cdn");

/** Fetch live data and build the { movie, theatres:[{ sessions }] } payload. */
async function fetchData() {
  const best = await findMovieByTitle(MOVIE);
  if (!best) throw new Error(`No movie matching "${MOVIE}"`);
  const movieId = best.match.id ?? best.match.movieId;
  const showtimes = await getShowtimes({ movieId, theatreId: THEATRE_ID, date: DATE });
  const matching = showtimes.filter((s) =>
    String(s.format ?? "").toLowerCase().includes(FORMAT.toLowerCase())
  );
  if (matching.length === 0) throw new Error(`No "${FORMAT}" showtimes for ${MOVIE} at ${THEATRE_ID} on ${DATE}`);

  // Mirror render_seat_map_html's session assembly in index.js. compactRows is
  // shared, so the only thing to keep in sync here is this field mapping.
  const sessions = [];
  for (const session of matching) {
    const { layout, availability } = await getRawSeatMap({ theatreId: THEATRE_ID, showtimeId: session.showtimeId });
    sessions.push({
      showtimeId: session.showtimeId,
      startTime: session.startTime,
      format: session.format,
      auditorium: session.auditorium,
      seatsRemaining: session.seatsRemaining,
      isSoldOut: session.isSoldOut,
      buyUrl: session.buyUrl ?? null,
      onlineEnabled: session.isShowtimeEnabledOnline !== false,
      r: compactRows(layout?.standardSeats?.rows ?? [], availability?.seatAvailabilities ?? {}),
    });
  }

  return {
    movie: { name: best.match.title ?? best.match.name, runtimeInMinutes: best.match.runtimeInMinutes, genres: best.match.genres },
    date: DATE,
    theatres: [{ id: THEATRE_ID, name: "Cineplex Cinemas Winston Churchill & VIP", address: "2081 Winston Park Dr., Oakville ON", city: "", province: "", distanceKm: 6, sessions }],
  };
}

async function loadData() {
  if (!refresh && existsSync(FIXTURE)) {
    return JSON.parse(readFileSync(FIXTURE, "utf8"));
  }
  console.log(`Fetching live data (${MOVIE} · ${FORMAT} · theatre ${THEATRE_ID} · ${DATE})…`);
  const data = await fetchData();
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(data));
  console.log(`Cached fixture → ${FIXTURE} (rerun with --refresh to update it)`);
  return data;
}

/** Rebuild preview.html from the current template + fixture data. */
function build(data) {
  const payload = {
    ...data,
    generatedAt: new Date().toISOString(),
    defaultScoreOptions: { excludeFrontRows: 0, excludeSideSeats: 0, minContiguous: 1 },
  };
  const html = cdnMode
    ? buildSeatMapWidget(payload, { shellSrc: "./dist/seatmap-shell.min.js" })
    : buildSeatMapHtml(payload);
  writeFileSync(OUT, html);
  const kb = (html.length / 1024).toFixed(0);
  const mode = cdnMode ? "cdn wrapper + local shell" : "self-contained";
  console.log(`Built preview.html (${mode}, ${kb} KB, ~${Math.round(html.length / 3.5)} tokens) — open:`);
  console.log(`  file:///${OUT.replace(/\\/g, "/")}`);
}

const data = await loadData();
build(data);

if (watchMode) {
  // buildSeatMapHtml reads the template at module-load, so re-import with a
  // cache-busting query each rebuild to pick up template edits without a
  // fixture re-fetch.
  const tplPath = join(ROOT, "src", "seatMapTemplate.html");
  console.log("\nWatching src/seatMapTemplate.html — edit and save to rebuild. Ctrl+C to stop.");
  let building = false;
  watch(tplPath, async () => {
    if (building) return;
    building = true;
    setTimeout(async () => {
      try {
        const mod = await import(`../src/seatMapTemplate.js?t=${Date.now()}`);
        const html = mod.buildSeatMapHtml({
          ...data,
          generatedAt: new Date().toISOString(),
          defaultScoreOptions: { excludeFrontRows: 0, excludeSideSeats: 0, minContiguous: 1 },
        });
        writeFileSync(OUT, html);
        console.log(`[${new Date().toLocaleTimeString()}] rebuilt preview.html — refresh your browser`);
      } catch (err) {
        console.error("rebuild failed:", err.message);
      }
      building = false;
    }, 80);
  });
}
