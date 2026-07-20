/**
 * All HTTP calls to Cineplex's (undocumented, public) web API live here.
 *
 * This is a personal-use tool scraping Cineplex's internal JSON endpoints —
 * there is no official partner API for this data. Keep request volume low,
 * cache aggressively, and fail gracefully. See PRD sections 1, 5, 9, 10.
 *
 * Endpoint status (as of 2026-07-19): all four endpoints below are confirmed
 * against live responses. They were found by following a Google "Showtimes
 * API" partner deep link (Cineplex feeds Google structured showtime data,
 * and the deep link exposes Cineplex's real internal IDs: `LocationId` /
 * `VistaSessionId`, backed by Vista Cinema software) and by reading the
 * `Ocp-Apim-Subscription-Key` Cineplex's own cineplex.com bundle sends with
 * every theatrical-API request — see CAPTURE.md for the full walkthrough.
 */

// Theatre/movie/showtime discovery — an Azure APIM-fronted API that requires
// THEATRICAL_SUBSCRIPTION_KEY below.
const THEATRICAL_BASE_URL = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1";

// Seat layout/availability — confirmed working with no auth or subscription
// key at all (see CAPTURE.md).
const TICKETING_BASE_URL = "https://apis.cineplex.com/prod/ticketing/api/v1";

// Static "app identity" key Cineplex's own cineplex.com bundle sends with
// every theatrical-API request — shipped to every visitor's browser inside a
// public, unauthenticated JS chunk, not a per-user secret. Captured
// 2026-07-19 from a cineplex.com `_next/static/chunks/*.js` file (search it
// for "Ocp-Apim-Subscription-Key"). If Cineplex rotates it, THEATRICAL_BASE_URL
// calls will start 401ing with "Access denied due to missing subscription
// key" and it needs re-capturing the same way.
const THEATRICAL_SUBSCRIPTION_KEY = "dcdac5601d864addbc2675a2e96cb1f8";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DAY_MS = 24 * 60 * 60 * 1000;
const THEATRE_MOVIE_CACHE_TTL_MS = DAY_MS; // theatres/movies change rarely
// Seat layout (row/seat geometry) is static per auditorium+showtime — only
// availability needs to be fetched fresh on every call.
const SEAT_LAYOUT_CACHE_TTL_MS = DAY_MS;

export class CineplexApiError extends Error {
  constructor(message, { cause, url } = {}) {
    super(message);
    this.name = "CineplexApiError";
    this.url = url;
    if (cause) this.cause = cause;
  }
}

/** Minimal in-memory cache with optional per-entry TTL. Process-lifetime by default. */
class SimpleCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = null) {
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }
}

/**
 * Serializes async work with a minimum delay between items, so we never
 * issue a concurrent burst of requests at Cineplex (PRD section 10:
 * rate limiting, especially for seat-map fetches while scoring multiple
 * showtimes in one find_optimal_showtimes call).
 */
class RequestThrottle {
  constructor(minDelayMs = 350) {
    this.minDelayMs = minDelayMs;
    this.tail = Promise.resolve();
  }

  schedule(fn) {
    const run = this.tail.then(fn, fn);
    // Whether fn succeeds or fails, wait minDelayMs before the next item runs.
    this.tail = run.then(
      () => new Promise((resolve) => setTimeout(resolve, this.minDelayMs)),
      () => new Promise((resolve) => setTimeout(resolve, this.minDelayMs))
    );
    return run;
  }
}

const cache = new SimpleCache();
const throttle = new RequestThrottle();

async function cineplexFetch(url, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        ...extraHeaders,
      },
    });
  } catch (err) {
    throw new CineplexApiError(
      `Network error contacting Cineplex API: ${err.message}`,
      { cause: err, url }
    );
  }

  if (!res.ok) {
    throw new CineplexApiError(
      `Cineplex API returned ${res.status} ${res.statusText} for ${url}`,
      { url }
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new CineplexApiError(
      `Cineplex API returned a non-JSON response for ${url} (Cineplex may have changed its response format, or is blocking this request)`,
      { cause: err, url }
    );
  }
}

/** Throttled + cached GET. Callers should not call cineplexFetch directly. */
function throttledFetch(url, extraHeaders) {
  return throttle.schedule(() => cineplexFetch(url, extraHeaders));
}

function theatricalHeaders() {
  return { "Ocp-Apim-Subscription-Key": THEATRICAL_SUBSCRIPTION_KEY };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Theatres + movies
// ---------------------------------------------------------------------------

/**
 * Find theatres near a location.
 * @param {{ lat: number, lon: number, rangeKm?: number }} opts
 */
export async function getTheatres({ lat, lon, rangeKm = 50 } = {}) {
  if (lat === undefined || lon === undefined) {
    throw new CineplexApiError(
      "getTheatres requires lat and lon — Cineplex's theatre-search endpoint is location-based, with no unfiltered 'list every theatre' mode."
    );
  }

  const date = todayIsoDate();
  const cacheKey = `theatres:${lat}:${lon}:${rangeKm}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    language: "en",
    latitude: String(lat),
    longitude: String(lon),
    accuracyKm: String(rangeKm),
    date,
  });

  const url = `${THEATRICAL_BASE_URL}/theatres/playingnearby?${params.toString()}`;
  const data = await throttledFetch(url, theatricalHeaders());
  const theatres = Array.isArray(data) ? data : [];
  cache.set(cacheKey, theatres, THEATRE_MOVIE_CACHE_TTL_MS);
  return theatres;
}

/** Fetch Cineplex's full current movie catalog (cached for the process lifetime). */
export async function getAllMovies() {
  const cacheKey = "movies:all";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ language: "en" });
  const url = `${THEATRICAL_BASE_URL}/movies?${params.toString()}`;
  const data = await throttledFetch(url, theatricalHeaders());
  const movies = data?.items ?? [];
  cache.set(cacheKey, movies, THEATRE_MOVIE_CACHE_TTL_MS);
  return movies;
}

// ---------------------------------------------------------------------------
// Fuzzy movie title matching (built on getAllMovies)
// ---------------------------------------------------------------------------

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Score a candidate title against a query: higher is a better match. */
function titleMatchScore(query, candidate) {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (!q || !c) return -Infinity;
  if (q === c) return 1000;
  if (c.startsWith(q)) return 900 - (c.length - q.length);
  if (c.includes(q)) return 700 - (c.length - q.length);

  const dist = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length);
  const similarity = 1 - dist / maxLen;
  return similarity >= 0.6 ? 400 + similarity * 100 : -Infinity;
}

/**
 * Best-fuzzy-match a movie by title against the full catalog.
 * @returns {Promise<{ match: object, score: number } | null>}
 */
export async function findMovieByTitle(title) {
  const movies = await getAllMovies();
  let best = null;
  for (const movie of movies) {
    const candidateTitle = movie.name ?? movie.title ?? "";
    const score = titleMatchScore(title, candidateTitle);
    if (score > -Infinity && (!best || score > best.score)) {
      best = { match: movie, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Showtimes
// ---------------------------------------------------------------------------

/**
 * Showtimes for a movie, at a theatre, on a date.
 * @param {{ movieId?: number|string, theatreId: number|string, date: string }} params
 */
export async function getShowtimes({ movieId, theatreId, date }) {
  const params = new URLSearchParams({
    language: "en",
    locationId: String(theatreId),
    date,
  });
  const url = `${THEATRICAL_BASE_URL}/showtimes?${params.toString()}`;

  let raw;
  try {
    raw = await throttledFetch(url, theatricalHeaders());
  } catch (err) {
    throw new CineplexApiError(`Failed to fetch showtimes: ${err.message}`, { cause: err, url });
  }

  const theatreEntry = Array.isArray(raw)
    ? raw.find((t) => String(t.theatreId) === String(theatreId)) ?? raw[0]
    : null;
  const dateEntry = theatreEntry?.dates?.find((d) => (d.startDate ?? "").slice(0, 10) === date);
  const movies = dateEntry?.movies ?? [];
  const movieEntries =
    movieId !== undefined ? movies.filter((m) => String(m.id) === String(movieId)) : movies;

  const sessions = [];
  for (const movieEntry of movieEntries) {
    for (const experience of movieEntry.experiences ?? []) {
      const format = (experience.experienceTypes ?? []).join(" ");
      for (const s of experience.sessions ?? []) {
        sessions.push({
          showtimeId: s.vistaSessionId,
          startTime: s.showStartDateTime,
          format,
          theatreId,
          movieId: movieEntry.id,
          auditorium: s.auditorium,
          seatsRemaining: s.seatsRemaining,
          isSoldOut: s.isSoldOut,
        });
      }
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Seat map — confirmed working with no auth required.
// ---------------------------------------------------------------------------

async function getSeatLayout(theatreId, showtimeId) {
  const cacheKey = `seatlayout:${theatreId}:${showtimeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${TICKETING_BASE_URL}/theatre/${encodeURIComponent(theatreId)}/showtime/${encodeURIComponent(showtimeId)}/seat-layout`;
  const data = await throttledFetch(url);
  cache.set(cacheKey, data, SEAT_LAYOUT_CACHE_TTL_MS);
  return data;
}

/** Never cached — seat status changes as people book/abandon carts. */
async function getSeatAvailability(theatreId, showtimeId) {
  const url = `${TICKETING_BASE_URL}/theatre/${encodeURIComponent(theatreId)}/showtime/${encodeURIComponent(showtimeId)}/seat-availability`;
  return throttledFetch(url);
}

/**
 * Fetch the seat layout + live availability for a showtime.
 * @param {{ theatreId: number|string, showtimeId: number|string }} params
 */
export async function getRawSeatMap({ theatreId, showtimeId }) {
  if (theatreId === undefined || showtimeId === undefined) {
    throw new CineplexApiError("getRawSeatMap requires both theatreId and showtimeId.");
  }
  const layout = await getSeatLayout(theatreId, showtimeId);
  const availability = await getSeatAvailability(theatreId, showtimeId);
  return { layout, availability };
}

/**
 * Converts Cineplex's raw seat-layout + seat-availability responses into the
 * normalized shape seatScoring.js expects:
 *   { rows: [ { row, seats: [ { number, status } ] } ] }
 *
 * This is the only place that needs to change if Cineplex's raw response
 * format shifts. Rows with no seats (aisle/gap rows between sections) are
 * dropped entirely — unlike a rendering adapter, a scoring adapter must not
 * let a physical gap count as a "row" for excludeFrontRows purposes.
 */
export function normalizeCineplexSeatMap({ layout, availability } = {}) {
  try {
    const statuses = availability?.seatAvailabilities ?? {};
    const rawRows = layout?.standardSeats?.rows ?? [];
    const rows = rawRows
      .filter((r) => Array.isArray(r.seats) && r.seats.length > 0)
      .map((r) => ({
        row: String(r.label ?? r.number ?? ""),
        seats: r.seats.map((s) => ({
          number: Number(s.column),
          status: normalizeSeatStatus(statuses[s.id]),
        })),
      }));
    return { rows };
  } catch (err) {
    throw new CineplexApiError(
      `Failed to parse Cineplex seat map — the response shape may have changed. Underlying error: ${err.message}`,
      { cause: err }
    );
  }
}

function normalizeSeatStatus(rawStatus) {
  const s = String(rawStatus ?? "").toLowerCase();
  if (s === "available") return "available";
  if (s === "occupied") return "sold";
  return "other";
}
