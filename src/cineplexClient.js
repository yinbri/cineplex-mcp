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
// a subscription key (see resolveSubscriptionKey below).
const THEATRICAL_BASE_URL = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1";

// Seat layout/availability — confirmed working with no auth or subscription
// key at all (see CAPTURE.md).
const TICKETING_BASE_URL = "https://apis.cineplex.com/prod/ticketing/api/v1";

// Static "app identity" key Cineplex's own cineplex.com bundle sends with
// every theatrical-API request — shipped to every visitor's browser inside a
// public, unauthenticated JS chunk, not a per-user secret. Captured
// 2026-07-19 from a cineplex.com `_next/static/chunks/*.js` file, re-verified
// 2026-07-30 by the automatic discovery below.
//
// This is only the FALLBACK. The key is resolved at request time in this
// order (see resolveSubscriptionKey):
//   1. CINEPLEX_SUBSCRIPTION_KEY env var — explicit operator override
//   2. a key auto-discovered from cineplex.com's bundle after a 401
//   3. this bundled value
const BUNDLED_SUBSCRIPTION_KEY = "dcdac5601d864addbc2675a2e96cb1f8";

// cineplex.com's homepage, whose HTML references the JS chunks that carry the
// key. Only fetched if the current key gets rejected.
const CINEPLEX_HOME_URL = "https://www.cineplex.com/";

// Ceiling on how many chunks a single discovery pass will download. The
// homepage referenced 15 as of 2026-07-30 (~1.2 MB total); the cap stops a
// future bundle explosion from turning one 401 into a huge download.
const MAX_DISCOVERY_CHUNKS = 25;

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

// Cap on cached entries. A seat layout — by far the biggest thing cached — is
// ~40 KB, so 200 entries bounds the cache at roughly 8 MB. That matters
// because an MCP server is long-lived (Claude Desktop keeps the process alive
// for as long as the app is open) and a single busy theatre can have 40+
// sessions per day: without a cap, every showtime ever scored would be
// retained for its full 24h TTL.
const MAX_CACHE_ENTRIES = 200;

/**
 * Minimal in-memory cache with optional per-entry TTL and a bounded size.
 *
 * Expiry alone is not enough to bound memory: a TTL only frees an entry when
 * that same key is looked up again, so keys never queried twice would sit
 * until the process exits. Eviction sweeps expired entries regardless of
 * whether they're ever requested, then drops oldest-first if still over cap.
 */
export class SimpleCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.store = new Map();
    this.maxEntries = maxEntries;
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
    // Delete first so a re-set moves the key to the end of the Map's insertion
    // order — otherwise "oldest-first" eviction would drop a hot key that
    // happens to have been inserted long ago.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    if (this.store.size > this.maxEntries) this.evict();
  }

  /** Sweep every expired entry, then drop oldest-inserted until under cap. */
  evict() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && now > entry.expiresAt) this.store.delete(key);
    }
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  get size() {
    return this.store.size;
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

const MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const BASE_BACKOFF_MS = 500; // doubles per attempt: 500ms, then 1000ms
const MAX_RETRY_DELAY_MS = 5000; // ceiling on a server-supplied Retry-After

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which HTTP statuses are worth trying again. Deliberately narrow: a 4xx like
 * 401 (rotated subscription key) or 404 (bad ID) will fail identically on a
 * retry, so retrying only burns time and adds load. 429 and 5xx are transient
 * by definition, and 408 is an explicit "try again".
 *
 * Exported for unit tests.
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * How long to wait before retrying: honour a `Retry-After` header when the
 * server sends one (seconds, or an HTTP date — both forms are legal), capped
 * so a hostile or nonsense value can't stall a tool call for minutes.
 * Otherwise fall back to exponential backoff.
 *
 * Exported for unit tests.
 */
export function retryDelayMs(res, attempt) {
  const header = res?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * A single GET with retries on transient failures.
 *
 * Retries happen *inside* the throttle's scheduled slot (see throttledFetch),
 * so a request that is backing off holds the queue rather than letting other
 * calls pile onto an API that just told us to slow down. That backpressure is
 * intentional: worst case a request costs an extra ~1.5s, which is far better
 * than surfacing a transient 503 as a failed showtime.
 */
async function cineplexFetch(url, extraHeaders = {}) {
  let lastError;
  // Mutable: a rediscovered subscription key is swapped in mid-loop.
  let headers = extraHeaders;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": DEFAULT_USER_AGENT,
          ...headers,
        },
      });
    } catch (err) {
      // Network-level failure (DNS, socket reset) — often transient, so retry.
      lastError = new CineplexApiError(
        `Network error contacting Cineplex API: ${err.message}`,
        { cause: err, url }
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      // A rejected key on the theatrical API is the rotation case. Try to
      // re-capture it automatically; if that yields a new key, retry with it.
      if ((res.status === 401 || res.status === 403) && isTheatricalUrl(url)) {
        if (attempt < MAX_ATTEMPTS && (await adoptRediscoveredKey())) {
          headers = { ...headers, ...theatricalHeaders() };
          continue;
        }
        // Either discovery found nothing, or the key it found was rejected
        // too — don't keep sending a key we now know is bad.
        discoveredKey = null;
        throw new CineplexApiError(
          `Cineplex rejected the subscription key (${res.status} ${res.statusText}). It has most likely rotated, ` +
            `and automatic re-capture from cineplex.com did not produce a working replacement. ` +
            `Re-capture it by hand per CAPTURE.md and set CINEPLEX_SUBSCRIPTION_KEY to the new value — no code change needed.`,
          { url }
        );
      }

      if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      throw new CineplexApiError(
        `Cineplex API returned ${res.status} ${res.statusText} for ${url}`,
        { url }
      );
    }

    try {
      return await res.json();
    } catch (err) {
      // A malformed body is a shape/blocking problem, not a transient one.
      throw new CineplexApiError(
        `Cineplex API returned a non-JSON response for ${url} (Cineplex may have changed its response format, or is blocking this request)`,
        { cause: err, url }
      );
    }
  }

  throw lastError;
}

/** Throttled (and internally retrying) GET. Callers should not call cineplexFetch directly. */
function throttledFetch(url, extraHeaders) {
  return throttle.schedule(() => cineplexFetch(url, extraHeaders));
}

// ---------------------------------------------------------------------------
// Subscription key: resolution, and self-healing re-capture after a rotation
// ---------------------------------------------------------------------------

/** Set only after a discovered key has been proven to work. */
let discoveredKey = null;
/** One discovery pass per process, whether it succeeds or fails. */
let discoveryAttempted = false;

/**
 * The key to send with theatrical requests. Env override beats a discovered
 * key, which beats the bundled fallback.
 *
 * `.trim() || …` rather than `??` is deliberate: `CINEPLEX_SUBSCRIPTION_KEY=`
 * (set but empty) is a common config slip, and treating it as "no override"
 * beats sending an empty header and producing a 401 that looks exactly like a
 * real rotation.
 *
 * @param {Record<string,string|undefined>} [env] Injectable for tests.
 */
export function resolveSubscriptionKey(env = process.env) {
  const override = env.CINEPLEX_SUBSCRIPTION_KEY?.trim();
  if (override) return override;
  return discoveredKey ?? BUNDLED_SUBSCRIPTION_KEY;
}

function theatricalHeaders() {
  return { "Ocp-Apim-Subscription-Key": resolveSubscriptionKey() };
}

function isTheatricalUrl(url) {
  return String(url).startsWith(THEATRICAL_BASE_URL);
}

/**
 * Pull `_next/static/chunks/*.js` URLs out of cineplex.com's homepage HTML.
 * Pure; exported for tests.
 */
export function extractChunkUrls(html) {
  const urls = new Set();
  for (const match of String(html).matchAll(/["'(]([^"'()]*_next\/static\/[^"')]*?\.js)/g)) {
    const ref = match[1];
    try {
      // Next.js emits absolute URLs here today, but relative refs are valid
      // too — resolve both against the homepage.
      urls.add(new URL(ref, CINEPLEX_HOME_URL).href);
    } catch {
      // Unparseable ref — skip it rather than abort the whole pass.
    }
  }
  return [...urls];
}

/**
 * Extract the *theatrical* subscription key from one JS chunk's source.
 *
 * Anchors on the theatrical API's URL, NOT on the header name. Cineplex's
 * bundle ships several subscription keys — as of 2026-07-30 a different one
 * guards their marketing "smart banner" API, and in `_app.js` it appears
 * BEFORE the others. Matching `Ocp-Apim-Subscription-Key` alone would happily
 * return that decoy, which then 401s forever and looks like a broken rotation.
 * Anchoring on the URL is what makes this safe.
 *
 * Pure; exported for tests.
 */
export function extractSubscriptionKey(source) {
  const text = String(source);
  const anchor = "apis.cineplex.com/prod/cpx/theatrical/api";
  const pattern = /Ocp-Apim-Subscription-Key"?\s*:\s*"([0-9a-f]{32})"/i;
  const WINDOW = 400;

  let from = 0;
  for (;;) {
    const at = text.indexOf(anchor, from);
    if (at === -1) return null;
    // Cineplex declares the URL then the headers object, so look forward
    // first; fall back to looking back in case a future build inverts them.
    const ahead = text.slice(at, at + WINDOW).match(pattern);
    if (ahead) return ahead[1];
    const behind = text.slice(Math.max(0, at - WINDOW), at).match(pattern);
    if (behind) return behind[1];
    from = at + anchor.length;
  }
}

/** Plain GET returning text. Used only by discovery (chunks aren't JSON). */
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": DEFAULT_USER_AGENT } });
  if (!res.ok) throw new CineplexApiError(`Fetching ${url} returned ${res.status}`, { url });
  return res.text();
}

/**
 * Re-capture the key the same way a human would (see CAPTURE.md): read
 * cineplex.com's homepage, walk its JS chunks, and pull the key that sits
 * next to the theatrical API URL.
 *
 * Deliberately NOT routed through `throttle`: discovery is triggered from
 * inside a request that is already occupying the throttle's slot, so
 * scheduling more work on that same queue would wait on a promise that can
 * only resolve once discovery finishes — a deadlock. The pass is sequential
 * and one-at-a-time regardless, so it never bursts.
 */
async function discoverSubscriptionKey() {
  const html = await fetchText(CINEPLEX_HOME_URL);
  const chunks = extractChunkUrls(html).slice(0, MAX_DISCOVERY_CHUNKS);
  for (const url of chunks) {
    let source;
    try {
      source = await fetchText(url);
    } catch {
      continue; // one bad chunk shouldn't end the pass
    }
    const key = extractSubscriptionKey(source);
    if (key) return key;
  }
  return null;
}

/**
 * Try once per process to replace a rejected key with a freshly discovered
 * one. Returns true only if a genuinely different key was adopted, in which
 * case the caller should retry — that retry IS the validation, and the caller
 * clears `discoveredKey` if it fails too.
 */
async function adoptRediscoveredKey() {
  // An env override is explicit operator intent; never silently override it.
  if (process.env.CINEPLEX_SUBSCRIPTION_KEY?.trim()) return false;
  if (discoveryAttempted) return false;
  discoveryAttempted = true;

  let candidate = null;
  try {
    candidate = await discoverSubscriptionKey();
  } catch {
    return false; // network trouble mid-discovery — fall through to the error
  }
  if (!candidate || candidate === resolveSubscriptionKey()) return false;

  discoveredKey = candidate;
  console.error("cineplex-mcp: subscription key was rejected; adopted a newly discovered key from cineplex.com");
  return true;
}

/** Test-only: reset discovery state between cases. */
export function _resetKeyDiscovery() {
  discoveredKey = null;
  discoveryAttempted = false;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the public desktop "buy tickets" / seat-preview URL for a session:
 *   https://www.cineplex.com/ticketing/preview?theatreId=…&showtimeId=…&dbox=…
 *
 * This is a real www.cineplex.com page that loads without a session token and
 * leads into Cineplex's buy flow. We construct it because Cineplex only hands
 * us the mobile variant (`seatMapUrl`, under /en-Mobile/) — we reuse its `dbox`
 * flag so D-BOX showtimes stay correct. Deliberately NOT the API's
 * redirect-to-ticketing endpoints: those 401 ("User session token not set")
 * when opened cold, since they need Cineplex's own in-site session token.
 */
function seatPreviewUrl(theatreId, session) {
  if (session.vistaSessionId === undefined || session.vistaSessionId === null) return null;
  let dbox = "false";
  try {
    if (session.seatMapUrl) dbox = new URL(session.seatMapUrl).searchParams.get("dbox") || "false";
  } catch {
    // Malformed seatMapUrl — fall back to dbox=false.
  }
  const params = new URLSearchParams({
    theatreId: String(theatreId),
    showtimeId: String(session.vistaSessionId),
    dbox,
  });
  return `https://www.cineplex.com/ticketing/preview?${params.toString()}`;
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
          // Public desktop seat-preview / buy link for this session (see
          // seatPreviewUrl). Falls back to Cineplex's own deep link, then the
          // mobile seat-map URL, if construction ever fails.
          buyUrl: seatPreviewUrl(theatreId, s) ?? s.deeplinkUrl ?? s.seatMapUrl ?? null,
          isShowtimeEnabledOnline: s.isShowtimeEnabledOnline !== false,
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
          // `column` is the seat's grid position, which is what contiguity and
          // side-trimming reason about. It is NOT the seat number printed on
          // the ticket: Cineplex numbers seats in the opposite direction, so
          // column 3 is seat "A26" while column 28 is "A1". `label` carries
          // the real seat identifier through so results can name seats the
          // way the box office does.
          number: Number(s.column),
          label: s.label ?? null,
          status: normalizeSeatStatus(statuses[s.id], s.type),
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

// Cineplex marks accessible seating by seat type, not by availability. An
// empty wheelchair space reports as "Available" like any other seat.
const ACCESSIBLE_SEAT_TYPES = new Set(["Wheelchair", "Companion"]);

/**
 * Map Cineplex's status vocabulary onto the normalized one.
 *
 * Free accessible seating maps to "companion" rather than "available", so
 * scoring never hands a general party a wheelchair space as its "best block"
 * — which it otherwise does, since those seats are usually empty and sit dead
 * centre in the row. They stay visible on the rendered map (drawn as
 * accessible) for anyone who actually needs them; they're just not
 * *recommended*. "companion" is the status name the PRD's normalized shape
 * already reserved for this.
 *
 * Anything that is neither available nor sold — Cineplex also returns
 * "Broken" — becomes "other": not bookable, and not counted as available.
 */
function normalizeSeatStatus(rawStatus, seatType) {
  const s = String(rawStatus ?? "").toLowerCase();
  if (s === "occupied") return "sold";
  if (s === "available") {
    return ACCESSIBLE_SEAT_TYPES.has(seatType) ? "companion" : "available";
  }
  return "other";
}
