# Capture record — how the real endpoints were found (2026-07-19)

All four Cineplex data calls are now confirmed against live responses. This
document is a record of how they were found, kept so a future re-capture (if
Cineplex changes something) doesn't have to start from zero.

## What's confirmed

| Function | Endpoint | Auth |
|---|---|---|
| `getTheatres` | `GET apis.cineplex.com/prod/cpx/theatrical/api/v1/theatres/playingnearby` | `Ocp-Apim-Subscription-Key` |
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

## If this breaks in the future

- **Theatrical API starts 401ing** → the subscription key rotated. Re-run
  step 3: fetch `cineplex.com`'s current `_next/static/chunks/*.js` files
  (the exact filenames change per deploy — check
  `performance.getEntriesByType('resource')` in a live browser session, or
  just grep every chunk) and search for `Ocp-Apim-Subscription-Key`.
- **Ticketing API starts requiring auth** → check whether a session token
  is now needed. If a long-lived token/key turns out to be involved, load it
  from an environment variable — never hardcode it. A short-lived per-request
  token should be fetched automatically rather than configured.
- **A response shape changes** → `normalizeCineplexSeatMap()` in
  `cineplexClient.js` is the sole adapter between Cineplex's raw JSON and
  `seatScoring.js`; only it needs to change, per the architecture note in
  `README.md`.
