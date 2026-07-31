# Capture record — how the real endpoints were found (2026-07-19)

All four Cineplex data calls are now confirmed against live responses. This
document is a record of how they were found, kept so a future re-capture (if
Cineplex changes something) doesn't have to start from zero.

Step 3 below (recovering the subscription key) is now **automated** — the
server re-runs it itself when the key is rejected, and falls back to this
manual procedure only if that fails. See "If this breaks in the future".

Last verified 2026-07-30: the bundled key still matches the one in
cineplex.com's live bundle, and the theatrical API accepts it (HTTP 200).

## What's confirmed

| Function | Endpoint | Auth |
|---|---|---|
| `getTheatres` | `GET apis.cineplex.com/prod/cpx/theatrical/api/v1/theatres/playingnearby` | `Ocp-Apim-Subscription-Key` |
| `getAllTheatres` | `GET apis.cineplex.com/prod/cpx/theatrical/api/v1/theatres` | `Ocp-Apim-Subscription-Key` |
| `getAllMovies` / `findMovieByTitle` | `GET apis.cineplex.com/prod/cpx/theatrical/api/v1/movies` | `Ocp-Apim-Subscription-Key` |
| `getShowtimes` | `GET apis.cineplex.com/prod/cpx/theatrical/api/v1/showtimes` | `Ocp-Apim-Subscription-Key` |
| `getRawSeatMap` | `GET apis.cineplex.com/prod/ticketing/api/v1/theatre/{id}/showtime/{id}/seat-layout` and `.../seat-availability` | none |

## How they were found

1. **Google's Showtimes panel.** Searching e.g. "the odyssey showtimes
   toronto" surfaces Google's own showtimes widget — Cineplex is enrolled as
   a Google Showtimes data partner (`utm_medium=showtimesapi` appears on the
   outbound link), not scraped by Google. Clicking a showtime's "Buy
   tickets" popup and following its `apis.cineplex.com` source link lands on
   `cineplex.com/movie/{slug}?...&VistaSessionId=...&LocationId=...` — a
   real, live `(theatreId, showtimeId)` pair, and confirmation that
   Cineplex's booking backend is **Vista Cinema** software (hence the
   `LocationId` / `VistaSessionId` naming).
2. **The ticketing endpoints** (seat-layout/seat-availability) were then
   tested directly with that real ID pair and returned HTTP 200 — no
   session, cookie, or API key required.
3. **The theatrical endpoints** (theatres/movies/showtimes discovery) 401'd
   with `"Access denied due to missing subscription key"`. The key itself is
   not a per-user secret — it's a static value cineplex.com's own frontend
   bundle sends with every request, shipped to every visitor's browser. It
   was found by downloading cineplex.com's Next.js JS chunks
   (`https://www.cineplex.com/next-static-files/_next/static/chunks/*.js`)
   and grepping for `Ocp-Apim-Subscription-Key`. The same grep also
   surfaced the full endpoint list in one pass: `theatres/playingnearby`,
   `theatres`, `movies`, `movies/bookable`, `movies/personalized`,
   `showtimes`.
4. Response shapes were read directly off the live JSON (see
   `cineplexClient.js` for the exact fields consumed) — nothing here is
   guessed.
5. **The full theatre directory** (`/theatres`, no origin parameter) was
   confirmed 2026-07-31. Unlike `playingnearby` it takes no coordinates and
   returns every Cineplex theatre in Canada — 152 at capture, each carrying
   `location.geoLocation.{latitude,longitude}`, city, province, and postal
   code. The response is grouped into `favouriteTheatres` / `nearbyTheatres` /
   `otherTheatres`; without a signed-in user the grouping is not meaningful,
   and the buckets overlap, so the client concatenates and de-duplicates them.
   This is what lets a plain location string ("Toronto", "Scotiabank Theatre")
   resolve to coordinates without a geocoding service.

## Behaviour worth knowing: `accuracyKm` is ignored

`theatres/playingnearby` accepts an `accuracyKm` parameter and then disregards
it — it always returns its 15 nearest theatres. Verified 2026-07-31 from Moose
Jaw, SK: `accuracyKm=1` and `accuracyKm=200` returned an identical list, the
farthest theatre 599.7 km away. `getTheatres` therefore filters by
`location.distanceToOriginInMeters` itself. The parameter is still sent, so
the filter degrades to a no-op should Cineplex ever start honouring it.

## If this breaks in the future

- **Theatrical API starts 401ing** → the subscription key rotated. **The
  server now tries to fix this itself**: on a 401 it performs step 3
  automatically (homepage → chunk list → extract the key next to the
  theatrical API URL), adopts the key if it works, and retries. It does this
  at most once per process and only after a failure, so it costs nothing
  during normal operation.

  If that automatic pass fails, the error says so and recovery is manual:
  1. Set `CINEPLEX_SUBSCRIPTION_KEY=<new key>` in the MCP server's env — this
     overrides everything, takes effect on restart, and needs no code change.
  2. Re-capture the key by re-running step 3 by hand: fetch `cineplex.com`'s
     current `_next/static/chunks/*.js` files (filenames change per deploy —
     check `performance.getEntriesByType('resource')` in a live browser
     session, or just grep every chunk) and search for
     `Ocp-Apim-Subscription-Key`.
  3. Once confirmed, update `BUNDLED_SUBSCRIPTION_KEY` in
     `cineplexClient.js` so a fresh clone works without the env var.

  **When grepping by hand, do not just take the first key you find.** The
  bundle contains several subscription keys — as of 2026-07-30 a different
  one guards Cineplex's marketing "smart banner" API and appears *earlier*
  in `_app.js`. The one you want sits beside
  `apis.cineplex.com/prod/cpx/theatrical/api` (found in `9026-*.js` on that
  date). The automatic extractor anchors on that URL for exactly this
  reason.
- **Ticketing API starts requiring auth** → check whether a session token
  is now needed. If a long-lived token/key turns out to be involved, load it
  from an environment variable — never hardcode it. A short-lived per-request
  token should be fetched automatically rather than configured.
- **A response shape changes** → `normalizeCineplexSeatMap()` in
  `cineplexClient.js` is the sole adapter between Cineplex's raw JSON and
  `seatScoring.js`; only it needs to change, per the architecture note in
  `README.md`.
