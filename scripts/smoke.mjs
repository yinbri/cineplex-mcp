/**
 * Live smoke test — the one command that answers "is Cineplex still up, and
 * are the endpoints this server depends on still valid?"
 *
 *   npm run smoke
 *
 * Unlike `npm test` (pure, offline, always safe to run), this makes real
 * requests to apis.cineplex.com. It exercises all five endpoints end to end,
 * chaining each result into the next the way the MCP tools do:
 *
 *   theatre directory -> location resolution -> theatres -> movies ->
 *   showtimes -> seat layout + availability -> score
 *
 * Exits non-zero if any step fails, so it can be run from a terminal or a
 * scheduled check and trusted to report honestly. A failure here almost
 * always means something changed upstream — see CAPTURE.md's "If this breaks
 * in the future" section, which maps each symptom to its fix.
 */
import {
  getTheatres,
  getAllTheatres,
  getAllMovies,
  findMovieByTitle,
  getShowtimes,
  getRawSeatMap,
  normalizeCineplexSeatMap,
} from "../src/cineplexClient.js";
import { scoreSeatMap } from "../src/seatScoring.js";
import { resolveLocation } from "../src/locationResolver.js";

// Downtown Toronto. Any Canadian coordinates work; this just needs to be
// somewhere with enough theatres that the chain below has something to chew on.
const LAT = 43.6532;
const LON = -79.3832;
const RANGE_KM = 25;

const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => console.log(`  FAIL ${msg}`);

async function main() {
  console.log(`Smoke test against live Cineplex endpoints (${new Date().toISOString()})\n`);

  // 0. Theatre directory + location resolution. The directory is its own
  // endpoint (`/theatres`, no origin), and it's what lets a location string
  // name a theatre or a city — so a change in its shape breaks lookups that
  // the coordinate-based chain below would never notice.
  const directory = await getAllTheatres();
  if (directory.length === 0) throw new Error("theatres returned an empty directory");
  const withCoords = directory.filter((t) => t.location?.geoLocation?.latitude != null).length;
  if (withCoords === 0) {
    throw new Error("no theatre in the directory has coordinates — location.geoLocation may have moved");
  }
  pass(`theatre directory: ${directory.length} theatres, ${withCoords} with coordinates`);

  const resolved = resolveLocation("Toronto", directory);
  if (!resolved.found) throw new Error(`location resolution failed for "Toronto": ${resolved.message}`);
  pass(`location: "Toronto" -> ${resolved.lat}, ${resolved.lon} (${resolved.source}, ${resolved.precision})`);

  // 1. Theatres
  const theatres = await getTheatres({ lat: LAT, lon: LON, rangeKm: RANGE_KM });
  if (theatres.length === 0) throw new Error("theatres/playingnearby returned no theatres");
  const theatre = theatres[0];
  pass(`theatres in range: ${theatres.length} within ${RANGE_KM}km — nearest is ${theatre.theatreName} (${theatre.theatreId})`);

  // 2. Movies + fuzzy matching
  const movies = await getAllMovies();
  if (movies.length === 0) throw new Error("movies returned an empty catalog");
  pass(`movies: ${movies.length} in catalog`);

  const sampleTitle = movies[0].name ?? movies[0].title;
  const matched = await findMovieByTitle(sampleTitle);
  if (!matched) throw new Error(`fuzzy match failed to find "${sampleTitle}", which came from the catalog itself`);
  pass(`fuzzy match: "${sampleTitle}" -> id ${matched.match.id} (score ${matched.score})`);

  // 3. Showtimes for today at the nearest theatre
  const date = new Date().toISOString().slice(0, 10);
  const sessions = await getShowtimes({ theatreId: theatre.theatreId, date });
  if (sessions.length === 0) {
    // Not a failure: a theatre can legitimately have no sessions left today.
    console.log(`  skip showtimes: none listed at ${theatre.theatreName} for ${date} — nothing left to check`);
    console.log("\nPartial pass: discovery endpoints healthy, no session available to test seat data against.");
    return;
  }
  const session = sessions[0];
  pass(`showtimes: ${sessions.length} at ${theatre.theatreName} on ${date} — sampling ${session.startTime} (${session.format || "no format tag"})`);

  // 4. Seat layout + availability, normalized and scored
  const raw = await getRawSeatMap({ theatreId: theatre.theatreId, showtimeId: session.showtimeId });
  const normalized = normalizeCineplexSeatMap(raw);
  if (normalized.rows.length === 0) throw new Error("seat map normalized to zero rows — the response shape may have changed");
  const seatCount = normalized.rows.reduce((n, r) => n + r.seats.length, 0);
  pass(`seat map: ${normalized.rows.length} rows, ${seatCount} seats`);

  const score = scoreSeatMap(normalized);
  pass(`scoring: ${score.totalAvailable} available (${score.optimalAvailable} in the preferred zone), best block ${score.bestBlock ? `${score.bestBlock.length} together in row ${score.bestBlock.row}` : "none"}`);

  console.log("\nAll endpoints healthy.");
}

main().catch((err) => {
  fail(err.message);
  console.log("\nSee CAPTURE.md — 'If this breaks in the future' maps each failure to its fix.");
  process.exitCode = 1;
});
