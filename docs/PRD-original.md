> ## ⚠️ Historical document — superseded, do not follow
>
> This is the **original build spec**, written before the server existed. It
> is kept as a record of the research and reasoning behind the project. It is
> **not** a description of how the software works today, and several of its
> instructions are now actively wrong:
>
> - Section 5 says the showtime and seat-map endpoints are "Not yet known".
>   All four endpoints are confirmed, tested against captured fixtures, and
>   covered by a live smoke test.
> - Section 9 instructs you to ship `⚠️ UNVERIFIED` stubs and guessed field
>   parsing. Nothing in the codebase is guessed; don't reintroduce stubs.
> - Section 7 lists four MCP tools. There are six — the two seat-map
>   renderers (`render_seat_map_ascii`, `render_seat_map_html`) came later.
> - Section 6's file layout predates the seat-map rendering modules, the
>   widget shell build, and the test fixtures.
>
> **For current documentation, use:**
> [`README.md`](../README.md) (architecture, tools, setup) ·
> [`CAPTURE.md`](../CAPTURE.md) (endpoints and the subscription key) ·
> [`RELEASING.md`](../RELEASING.md) (versioning and tags).
>
> What's still worth reading here: the background research in §5 (why
> Fandango was ruled out, the Open Theatre Seats fallback), the non-goals in
> §3, and the design rationale in §6 for keeping seat scoring
> chain-agnostic — reasoning that shaped the code and isn't recorded
> elsewhere.

# PRD: Cineplex Canada MCP Server ("cineplex-mcp")

## 1. Summary

Build an MCP (Model Context Protocol) server that lets Claude answer requests
like:

> "Find showtimes for The Odyssey in IMAX 70mm near me with good seats — not
> the first 3 rows, not on the sides."

The server wraps Cineplex Canada's undocumented public website API to look up
theatres, movies, showtimes (with format/experience tags like IMAX, IMAX
70mm, UltraAVX, Dolby, VIP), and per-showtime seat maps, then applies a
seat-quality filter and returns only showtimes that have good seats
available.

This is a **personal-use tool**, not a commercial product. Cineplex has no
official partner API for this data — the implementation scrapes their
internal JSON endpoints. Build accordingly: cache aggressively, keep request
volume low, fail gracefully, and don't route around this note by pretending
otherwise.

## 2. Goals

- G1: Given a movie title + location + date, return which showtimes are in a
  given format (default IMAX, but should support any substring match like
  "IMAX 70mm", "UltraAVX", "Dolby").
- G2: For each matching showtime, determine whether it has acceptable seats
  available, where "acceptable" = not in the first N rows (default 3) and
  not within M seats of either wall (default 3), with at least one
  contiguous block of the requested size (default 1, but should support 2+
  for couples/groups).
- G3: Expose this as MCP tools Claude can call directly from a chat request,
  with no manual steps required by the end user at query time.
- G4: Be resilient to Cineplex changing response shapes or blocking
  requests — errors should be caught and surfaced clearly, not crash the
  server.

## 3. Non-goals

- No ticket purchasing/booking — read-only lookups only.
- No support for other Canadian chains (Landmark, Imagine) in v1 — but keep
  the seat-scoring module chain-agnostic so it could be reused later.
- No persistent database — in-memory/file cache is sufficient.
- No auth/login flows — only anonymous, publicly-reachable data.

## 4. Users

Single user (the requester), running this locally via Claude Desktop or
Claude Code, in Canada (Toronto area, but should work for any Cineplex
theatre location/postal code).

## 5. Background research already done

The following was verified before this PRD was written — use it, don't
re-derive it:

- Fandango's API is US-only and requires a paid partner agreement; not
  usable for Cineplex.
- Cineplex has no documented public API. However, these endpoints are
  known-working (verified via public reverse-engineering projects, e.g.
  `agottardo/cineplex-api-php`):
  - `GET https://www.cineplex.com/api/v1/theatres?language=en-us&range={km}&skip=0&take=1000` (optionally with `lat`/`lon` params)
  - `GET https://www.cineplex.com/api/v1/movies?language=en-us&marketLanguageCodeFilter=true&movieType=1&showTimeType=0&showtimeStatus=0&skip={n}&take={n}`
  - `GET https://www.cineplex.com/api/v1/movies/{movieId}/availabletheatres/dates?language=en-us&skip=0&take=1000`
- **Not yet known**: the endpoint for showtimes-by-theatre-by-date (with
  format tags), and the endpoint for a showtime's seat map. These must be
  captured by hand from a browser's Network tab (see Section 9 — this is a
  required setup task, not something to guess/hallucinate the shape of).
- A third-party site, **Open Theatre Seats** (opentheatreseats.com),
  independently publishes Cineplex showtimes and seat maps sourced from
  Cineplex's Vista ticketing API, refreshed every few minutes for near-term
  sessions. This is a candidate fallback data source if direct scraping
  proves too fragile (see Section 12, stretch goal).
- Cineplex's own marketing materials confirm showtimes are tagged with
  format/experience (IMAX, 3D, UltraAVX, etc.) and link directly to seat
  maps, which is consistent with what the seat-map endpoint should return.

## 6. Architecture

```
src/
  index.js           # MCP server entrypoint; registers tools, thin glue only
  cineplexClient.js   # All HTTP calls to Cineplex's API live here
  seatScoring.js       # Pure functions: normalize seat map -> score against
                        # row/side exclusion rules. No network calls. Unit-testable
                        # in isolation.
CAPTURE.md            # Human walkthrough for capturing the two unknown endpoints
README.md             # Setup + Claude Desktop/Code config instructions
package.json          # type: module, deps: @modelcontextprotocol/sdk, zod
```

Design principle: **seat-scoring logic must not know anything about
Cineplex's JSON shape.** It operates on a normalized shape:

```ts
{
  rows: [
    { row: string, seats: [ { number: number, status: "available"|"sold"|"companion"|"other", aisle: boolean } ] }
  ]
}
```

Rows ordered front-to-back. A separate adapter function
(`normalizeCineplexSeatMap`) converts Cineplex's raw response into this
shape — that's the only place that needs to change if Cineplex's response
format shifts.

## 7. MCP Tools to implement

### `find_theatres`
- Input: `{ lat?: number, lon?: number, rangeKm?: number }`
- Output: list of theatres (id, name, address) from Cineplex's `theatres`
  endpoint.

### `find_movie`
- Input: `{ title: string }`
- Output: best-fuzzy-match movie object (must surface the Cineplex movie ID
  used by other tools), or a clear "no match" message. Should page through
  results (Cineplex's movies endpoint is paginated) rather than only
  checking page 1.

### `find_optimal_showtimes`
- Input:
  ```ts
  {
    movieTitle: string,
    theatreId: string,
    date: string, // YYYY-MM-DD
    formatMatch?: string,      // default "IMAX"
    excludeFrontRows?: number, // default 3
    excludeSideSeats?: number, // default 3
    minContiguous?: number,    // default 1
  }
  ```
- Behavior:
  1. Resolve `movieTitle` → movie ID via the same logic as `find_movie`.
  2. Fetch showtimes for that movie/theatre/date.
  3. Filter to sessions whose format/experience field contains
     `formatMatch` (case-insensitive).
  4. For each matching session, fetch and score its seat map.
  5. Return both the full list (with scores) and a filtered `optimal` list
     containing only showtimes that clear the bar.
- Must handle a showtime whose seat map fetch fails without aborting the
  whole request — attach the error to that entry and continue.

### `get_optimal_seats`
- Input: `{ showtimeId: string, excludeFrontRows?: number, excludeSideSeats?: number, minContiguous?: number }`
- Output: score object for a single already-known showtime (useful when the
  caller already has a showtime ID from another flow).

## 8. Seat-scoring algorithm (already implemented — preserve this logic)

Given a normalized seat map and `excludeFrontRows`/`excludeSideSeats`:

1. Drop the first `excludeFrontRows` rows entirely.
2. For each remaining row, sort seats by number and trim `excludeSideSeats`
   from each end **by position within the row**, not by raw seat number —
   rows can have gaps (aisles, wheelchair spaces, missing numbers), so
   trimming by index rather than number avoids off-by-N errors from gaps.
3. Within the trimmed middle section of each row, find contiguous runs of
   `status === "available"` seats. Track the best (longest) run found across
   all eligible rows.
4. Return: `hasOptimalSeats` (boolean), `optimalAvailable` (count of
   available seats within eligible/trimmed zones), `bestBlock` (`{ row,
   startSeat, length }` or null), `totalAvailable` (available seats
   anywhere in the auditorium, for context).

This logic already exists and was unit-tested against a synthetic 10-row,
12-seat-wide auditorium — confirm the reimplementation still passes an
equivalent test before considering this done.

## 9. Required manual setup step (do not skip or fake this)

Cineplex's showtime-listing and seat-map endpoints are undocumented. Do not
guess their shape and ship guessed field-name parsing as if it were
verified — mark it clearly as unverified, the way the current stub code
does, until a real response has been captured.

Provide `CAPTURE.md` instructing the human operator to:

1. Open cineplex.com, DevTools → Network → Fetch/XHR filter.
2. Navigate to an IMAX showtime's seat selection screen.
3. Identify and copy (as fetch/cURL) the two requests: showtimes-by-theatre
   and seat-map-by-showtime.
4. Paste the real URLs into `cineplexClient.js`, replacing the `TODO`
   placeholders.
5. Compare real field names against the guessed ones in
   `normalizeCineplexSeatMap()` and the session-parsing code in
   `find_optimal_showtimes`, and correct them.
6. Note whether a session/auth token is required before the seat map is
   queryable (common in booking flows), and if so add a token-fetch step.

Ship the placeholder/stub versions of these two calls with clear inline
comments marking them `⚠️ UNVERIFIED`, functional error handling if the
guessed shape is wrong (don't crash, surface a clear error), and this doc.

## 10. Non-functional requirements

- **Resilience**: wrap all Cineplex HTTP calls with error handling that
  produces a clear message rather than an unhandled rejection/crash.
- **Caching**: theatre and movie lists change rarely — cache them in-memory
  for the process lifetime at minimum (stretch: on-disk cache with a TTL,
  e.g. 24h for theatres/movies, a few minutes for seat maps).
- **Rate limiting**: don't issue concurrent bursts of requests to Cineplex;
  serialize or lightly throttle calls, especially seat-map fetches when
  scoring multiple showtimes in one `find_optimal_showtimes` call.
- **No secrets in code**: if a session token turns out to be required, load
  it from an env var, not hardcoded.

## 11. Testing

- Unit tests for `seatScoring.js` covering: front-row exclusion, side-seat
  exclusion with row gaps, contiguous-run detection, and the
  `minContiguous` parameter (e.g. requesting 2 adjacent seats for a
  couple).
- These tests must not require network access — pure function tests only.
- Manual smoke test instructions in README for the two live endpoints
  (`find_theatres`, `find_movie`) which don't depend on the Section 9
  capture step.

## 12. Stretch goals (not required for v1)

- Fallback data source: if direct Cineplex scraping proves too fragile,
  add an adapter that instead fetches/parses Open Theatre Seats
  (opentheatreseats.com) pages as a secondary source — note this is
  snapshot data (refreshed periodically, not live) so should be labeled as
  such in tool output.
- On-disk cache with configurable TTL instead of in-memory-only.
- Support for multiple theatre chains behind the same `seatScoring.js`
  module.
- A `min_seats_together` convenience alias for group bookings.

## 13. Deliverables

- Working MCP server (`src/index.js`, `src/cineplexClient.js`,
  `src/seatScoring.js`) installable via `npm install` and runnable via
  `npm start`.
- `README.md` with Claude Desktop config snippet (`mcpServers` JSON block)
  and example prompts.
- `CAPTURE.md` per Section 9.
- Passing unit tests for `seatScoring.js`.
- Clear TODO/⚠️ markers on anything left unverified pending the Section 9
  capture step — the deliverable should be honest about what's tested vs.
  guessed, not present placeholder logic as finished.
