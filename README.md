# cineplex-mcp

An MCP (Model Context Protocol) server that lets Claude look up Cineplex
Canada showtimes and find ones with good seats available — e.g. "Find
showtimes for The Odyssey in IMAX 70mm near me with good seats, not the
first 3 rows, not on the sides."

**This is a personal-use tool, not a commercial product.** Cineplex has no
official partner API for this data; this server calls Cineplex's
undocumented public web endpoints directly. It's built to cache
aggressively, keep request volume low, and fail gracefully rather than
pretend otherwise: calls are throttled rather than fired in bursts, transient
failures (429/5xx, dropped sockets) are retried with backoff that honours
`Retry-After`, and anything still broken surfaces as a clear message instead
of a crash.

## Status: all five Cineplex data endpoints are confirmed working

All five calls this server depends on hit real, live `apis.cineplex.com`
endpoints, tested end-to-end against real responses — the original four as of
2026-07-19, the full theatre directory as of 2026-07-31. See
[`CAPTURE.md`](./CAPTURE.md) for how they were found and what to do if
Cineplex changes something in the future (e.g. rotates the theatrical API's
subscription key).

## Setup

```bash
npm install
```

Node.js 18+ is required (for built-in `fetch`).

No environment variables or session tokens are required — every endpoint
this server calls was confirmed to work unauthenticated (theatre/movie/
showtime discovery uses a static, public subscription key baked into
`cineplexClient.js`; seat data needs no key at all).

### If Cineplex rotates the subscription key

That key is public — Cineplex ships it to every visitor's browser — but it
will eventually be rotated, at which point theatre/movie/showtime lookups
start failing with a 401. The server resolves it from three sources, in
order:

1. **`CINEPLEX_SUBSCRIPTION_KEY`** (env var) — an explicit override. If set,
   it always wins and automatic discovery is skipped entirely.
2. **A key discovered automatically.** On a 401, the server re-captures the
   key the same way a human would (per `CAPTURE.md`): it reads
   cineplex.com's homepage, walks the `_next/static/chunks/*.js` it
   references, and extracts the key sitting next to the theatrical API's
   URL, then retries the request with it. This runs **only** after a
   rejected key, at most once per process, so normal operation costs nothing
   extra.
3. **The bundled fallback** in `cineplexClient.js` — verified current as of
   2026-07-30.

If automatic re-capture also fails, the error tells you so explicitly and
points at `CAPTURE.md`; recovery is then setting the env var, with no code
change or redeploy.

The extractor anchors on the theatrical API's URL rather than on the
`Ocp-Apim-Subscription-Key` header name, because Cineplex's bundle ships
several different subscription keys (a separate one guards their marketing
API, and it appears *earlier* in the bundle). Matching the header name alone
would return that decoy — a key that 401s forever while looking like a
successful re-capture.

## Running

```bash
npm start
```

This starts the MCP server on stdio, for use by an MCP client (Claude
Desktop, Claude Code, etc.) — it's not meant to be run standalone for
interactive use.

## Claude Desktop configuration

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cineplex": {
      "command": "node",
      "args": ["/absolute/path/to/cineplex-mcp/src/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

If you ever need to override the subscription key (see above), add an `env`
block — otherwise leave it out:

```json
"cineplex": {
  "command": "node",
  "args": ["/absolute/path/to/cineplex-mcp/src/index.js"],
  "env": { "CINEPLEX_SUBSCRIPTION_KEY": "…" }
}
```

## Claude Code configuration

```bash
claude mcp add cineplex -- node /absolute/path/to/cineplex-mcp/src/index.js
```

With an optional key override:

```bash
claude mcp add cineplex -e CINEPLEX_SUBSCRIPTION_KEY=… -- node /absolute/path/to/cineplex-mcp/src/index.js
```

## Tools exposed

- **`find_theatres`** — `{ location?, lat?, lon?, rangeKm? }` → nearby theatres
  (id, name, address, distance), nearest first, plus a `resolvedLocation` block
  saying how the location was understood.

  Send `lat`/`lon` when you can place the location yourself — that is the
  primary path. Send `location` for the things that need looking up: a postal
  code (`"M5B 2H1"`, or a bare FSA like `"M5B"`), a Cineplex theatre name
  (`"Yonge-Dundas"`), or a city that has a Cineplex theatre. See
  [Location input](#location-input) for how the two divide the work.
- **`find_movie`** — `{ title }` → best fuzzy match against Cineplex's full
  current movie catalog, including the Cineplex movie ID. Cineplex's `movies`
  endpoint returns the whole catalog in one response (it reports a
  `totalCount` matching the items it returns), so no pagination is involved.
- **`find_optimal_showtimes`** — `{ movieTitle, theatreId, date,
  formatMatch?, excludeFrontRows?, excludeSideSeats?, minContiguous? }` →
  showtimes matching a format (default `"IMAX"`, case-insensitive substring
  match — also works for `"IMAX 70mm"`, `"UltraAVX"`, `"Dolby"`, etc.),
  scored for seat quality. Returns both the full scored list and an
  `optimal` subset.
- **`get_optimal_seats`** — `{ theatreId, showtimeId, excludeFrontRows?,
  excludeSideSeats?, minContiguous? }` → seat score for a single already-known
  showtime. Cineplex's seat endpoints are keyed by the `(theatreId,
  showtimeId)` pair, not showtimeId alone.
- **`render_seat_map_ascii`** — **the default seat-map visualization.**
  `{ theatreId, showtimeId, partySize?, excludeFrontRows?, excludeSideSeats?,
  monochrome?, theatreName?, showLabel?, buyUrl? }`
  → a compact ASCII/emoji seat-map diagram as **plain text**: a centered SCREEN
  banner, the auditorium as a grid of squares (🟩 open, ⬛ taken, 🟪 accessible),
  the best `partySize`-block highlighted (🟦, centered within the run), a
  one-line recommendation, and a trailing `🎟 Buy tickets: <url>` line. Works in
  any MCP client with no extra setup — it's just text. The seat grid is pasted
  verbatim into a fenced code block; the buy line is kept **out** of the fence
  and rendered as a clickable Markdown link just below it (links don't linkify
  inside ```). Pass `buyUrl` through from `find_optimal_showtimes` for the
  correct D-BOX-aware link, or omit it to build a
  `cineplex.com/ticketing/preview` link from the IDs. Set `monochrome: true`
  (`·`/`▓`/`+`/`★`) where emoji width misaligns the grid. Rendering logic lives
  in `src/seatMapAscii.js`.

- **`render_seat_map_html`** — the **opt-in interactive** alternative; needs the
  bundled skill (see [below](#visualization-ascii-by-default-interactive-widget-optional)).
  `{ movieTitle, theatreId, date, theatreName?, theatreAddress?, distanceKm?,
  formatMatch?, excludeFrontRows?, excludeSideSeats?, minContiguous? }` → a
  complete, self-contained HTML page visualizing real seat availability:
  showtime chips, a pannable/zoomable auditorium seat map, live filter
  controls, and a stats strip. Meant to be rendered inline in the chat as a
  widget (via the Visualizer's `show_widget`), not saved to a file, published
  as a hosted artifact, or read as data — see `src/seatMapTemplate.html`/`.js`.
  The tool only injects real data into an already-built, already-tested
  template; it never generates new HTML/JS per call, so there's no risk of a
  fresh generation shipping a UI bug.

`theatreId`/`showtimeId` accept either a string or a number — Cineplex's IDs
are numeric, and `find_theatres`/`find_optimal_showtimes` hand them back as
numbers, so chaining one tool's output straight into the next one's input
just works.

## Location input

Cineplex's theatre search is coordinate-based. `find_theatres` takes either
coordinates or a `location` string, and the two are meant to split the work
rather than compete:

**Send `lat`/`lon` for anywhere you can already place** — cities,
neighbourhoods, landmarks, street addresses. A language model converts those
accurately and knows when it can't, so a lookup table would only duplicate it.
This is the expected path and the most precise one.

**Send `location` for what world knowledge gets wrong:**

| Input | Example | Resolved from |
|---|---|---|
| postal code / FSA | `"M5B 2H1"`, `"M5B"` | bundled FSA table |
| Cineplex theatre name | `"Yonge-Dundas"`, `"Courtney Park"` | live theatre directory |
| city with a theatre | `"Mississauga"`, `"London, ON"` | live theatre directory |
| coordinates as a string | `"43.65, -79.38"` | parsed, not looked up |

A postal code is also picked up from inside a longer string, so
`"123 Front St W, Toronto, ON M5J 2M2"` resolves by its postal code. Input is
case-, punctuation-, and accent-insensitive; a trailing country is ignored
(`"Halifax, NS, Canada"`); provinces work as a code or a full name.

Anything else returns `found: false` inviting you to pass coordinates. That is
the design, not a gap.

### Why postal codes specifically

They are the one input neither a model nor an open geocoder handles reliably.

Canada Post's postal file is proprietary, so OSM's coverage is thin: measured
against Nominatim on 2026-07-31, four of six sampled postal codes returned no
match, and `V6B 1A1` — downtown Vancouver — resolved to `48.87, -119.73`, about
400 km away near the Washington border.

Recall fares better but fails unpredictably. Claude's own from-memory
coordinates for 16 FSAs landed 12 within 10 km — Waterloo 0.1 km, Victoria
0.3 km — but placed `T9K` in Cold Lake when it is **Fort McMurray**, 264 km
off, stated exactly as confidently as the correct answers. A wrong coordinate
doesn't fail loudly; it returns a tidy list of theatres in the wrong city.

The bundled [GeoNames](https://www.geonames.org/) table
(`src/data/postalCodes.json`, 41 KB, CC BY 4.0) covers all 1652 FSAs. Rebuild
it with `npm run build:locations`.

### Precision

Every result reports how sharp it is:

- `exact` — coordinates, or a specific theatre.
- `fsa` — an urban postal area, a few blocks across.
- `city` — the centroid of that city's Cineplex theatres. Fine for a small
  city, loose for a big one: `"Toronto"` lands near Don Mills, because the
  suburban locations outvote the downtown ones, and returns Don Mills as the
  nearest theatre where coordinates for downtown return Yonge-Dundas. Prefer
  `lat`/`lon` for large cities.
- `region` — a rural FSA (a `0` in the second position, Canada Post's own
  convention). These span hundreds of kilometres; `X0A` covers the eastern
  Arctic and sits ~1800 km from Iqaluit. Labelled rather than passed off as a
  point.

### Search radius

`rangeKm` (default 50) is enforced by this server, not by Cineplex.
`theatres/playingnearby` accepts an `accuracyKm` parameter and ignores it,
always returning its 15 nearest theatres: from Moose Jaw, SK a 1 km and a
200 km request come back identical, the farthest theatre 599.7 km away. Results
are filtered by their reported distance so the radius means what it says. When
nothing is in range, the response names the nearest theatre and its distance,
so you know what to widen to.

### Seat-quality parameters

- `excludeFrontRows` (default `3`): drop this many front rows entirely.
- `excludeSideSeats` (default `3`): trim this many seats from each side of
  every remaining row (by position, not raw seat number, so aisle gaps
  don't cause off-by-N errors).
- `minContiguous` (default `1`): require a contiguous block of at least
  this many available seats — set to `2` for a couple, `4` for a group,
  etc.

Two things the scorer does on your behalf:

- **Seats are reported by their printed label** (`A21`, `GW4`) — the number
  actually on the ticket. Cineplex's seat *columns* run opposite to its seat
  *numbers* (column 3 is seat `A26`), so the grid position is used for
  adjacency but never shown as a seat number.
- **Free wheelchair and companion seating is never recommended.** Those spaces
  are usually empty and sit dead centre, so counting them as available made
  them the "best block" for every party that doesn't need them. They still
  appear on the rendered map (marked accessible) — they're just excluded from
  recommendations.

## Visualization: ASCII by default, interactive widget optional

There are two ways to *see* a seat map, and you get the first one for free.

### Default: the ASCII seat map (no setup)

Out of the box, seat maps render as text via **`render_seat_map_ascii`** — a
grid of emoji squares with your recommended block highlighted, printed straight
into the chat:

```
Cineplex Yonge-Dundas · The Odyssey · 7:00 PM IMAX
Recommended: row H, seats 8–9 (2 together, center)

   　　　ＳＣＲＥＥＮ
A  🟩🟩⬛⬛⬛🟩🟩🟩🟩🟩🟩🟩
B  🟩🟩🟩🟩🟩⬛🟩🟩🟩🟩🟩🟩
C  🟩⬛⬛🟩🟩🟩🟩🟩🟩🟩🟩🟩
D  🟩🟩🟩🟩🟩🟩🟩🟩⬛🟩🟩🟩
E  🟩🟩🟩🟩⬛🟩🟩🟩🟩🟩🟩🟩
F  🟩🟩🟩⬛⬛🟩🟩🟩🟩🟩🟩🟩
G  🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩⬛🟩
H  🟩🟩⬛⬛🟩🟩🟩🟦🟦🟩🟩🟩

🟩 open   ⬛ taken   🟦 your seats   🟪 accessible
```

(…plus a `🎟 Buy tickets: …` link below the diagram.)

This needs nothing beyond the MCP server itself. It works in Claude Code, a
plain terminal, or any MCP client, because the output is just text.

### Optional: the interactive widget (install the bundled skill)

For a richer view, this repo also ships a Claude skill at
[`.claude/skills/cineplex-seat-map`](./.claude/skills/cineplex-seat-map/SKILL.md).
Installing it makes Claude prefer **`render_seat_map_html`** and render its
output *inline in the chat as a live widget* — a pannable/zoomable auditorium
where you can switch between theatres and showtimes, drag the front-row /
side-seat / seats-together filters and watch the best block move in real time,
and read a live stats strip.

To install it, copy the skill folder into wherever your client loads skills
from (e.g. your user-level `~/.claude/skills/`), or just open this repo as your
project so `.claude/skills/` is picked up automatically. Removing it reverts
you to the ASCII map.

The widget requires a client that can render inline HTML widgets (the
Visualizer's `show_widget`). In a client without one, stay on the ASCII map —
`render_seat_map_html` would return raw HTML with nothing to display it.

To see the widget outside a chat client (e.g. while editing its UI), run
`npm run preview` — it writes a standalone `preview.html` you can open in any
browser, built from a cached fixture (fetched live once, then reused offline;
`npm run preview:watch` rebuilds on save). `npm run build:shell` recompiles
`dist/seatmap-shell.min.js` after any change to `src/seatMapTemplate.html`; see
the bump procedure documented on `SHELL_VERSION` in `src/seatMapTemplate.js`.

### How the two layers relate

**The MCP server works on its own.** All six tools return real data as plain
text/JSON — theatre lists, showtimes, seat scores, ASCII maps. You can ask
"which IMAX showtimes have good seats" and get a complete answer with no skill
involved. `render_seat_map_html` likewise just returns a finished HTML string;
a client is free to save it, open it, or ignore it.

**The skill is only the delivery layer for that HTML.** It can't function
without this server (it orchestrates these exact tools), but the server never
depends on the skill — which is why they live in one repo but stay cleanly
separable. In short: the server answers the question, the ASCII map draws it by
default, and the skill upgrades that picture to an interactive one.

## Example prompts

- "Find Cineplex theatres in Toronto." → Claude supplies the coordinates.
- "What's playing near M5B 2H1?" → resolved from the bundled postal table.
- "Find theatres within 10km of 123 Front St W, Toronto."
- "Find theatres near me at lat 43.65, lon -79.38."
- "Look up the movie 'The Odyssey' on Cineplex."
- "Find IMAX 70mm showtimes for The Odyssey at theatre 9806 on 2026-07-20
  with good seats, not the first 3 rows or within 3 seats of the wall."
- "Same as above but I need 2 seats together for me and my partner."
- "Show me the seat map for that 7pm showtime." → the ASCII diagram by
  default; the interactive widget instead if you've installed the skill.

## Testing

### Unit tests (no network required)

```bash
npm test
```

Runs the whole `test/` directory with Node's built-in test runner:

- `test/seatScoring.test.js` — scoring against a synthetic 10-row, 12-seat
  auditorium: front-row exclusion, side-seat exclusion with row gaps,
  contiguous-run detection, and the `minContiguous` parameter.
- `test/seatMapAscii.test.js` — ASCII rendering: open/taken/accessible glyph
  selection, the centered `partySize` highlight, monochrome mode, the
  "no block fits" message, the trailing buy-link line, and empty-layout
  handling.
- `test/cineplexClient.test.js` — cache expiry and bounded eviction, the retry
  policy (which statuses are retried, `Retry-After` handling, the retry loop
  itself), client-side `rangeKm` enforcement, and automatic subscription-key
  re-capture — all driven through a stubbed `fetch`, so it stays offline.
- `test/locationResolver.test.js` — the location cascade against the real
  bundled FSA table: coordinate parsing, postal codes (including the ones open
  geocoders and recall both get wrong), theatre-name matching, city lookup via
  the theatre directory, urban-vs-rural precision labelling, and the guarantee
  that an unresolvable string is reported rather than guessed at.
- `test/shellBuild.test.js` — that the committed `dist/` widget shell still
  matches `src/seatMapTemplate.html`, and that a shell change can't ship under
  an already-published `SHELL_VERSION`. See [`RELEASING.md`](./RELEASING.md).
- `test/cineplexAdapters.test.js` — the code that reads Cineplex's raw JSON,
  run against real captured responses in
  [`test/fixtures/`](./test/fixtures/README.md): seat-map normalization,
  showtime flattening and buy-link construction, fuzzy title matching, and a
  `compactRows` ↔ widget `inflate()` round trip. This is the layer that breaks
  when Cineplex changes shape, so the fixtures keep real field names and real
  value vocabularies.

All suites are pure and offline — no network access required. They run
in CI on every push and pull request (`.github/workflows/test.yml`) against
Node 18, 20, and 22.

### Live smoke test

```bash
npm run smoke
```

Unlike `npm test`, this makes real requests to Cineplex. It chains all five
endpoints the way the MCP tools do — theatre directory → location resolution →
theatres → movies → showtimes → seat layout + availability → score — and exits
non-zero if any step fails:

```
  ok   theatre directory: 152 theatres, 152 with coordinates
  ok   location: "Toronto" -> 43.6706, -79.3918 (cineplex-city, city)
  ok   theatres in range: 15 within 25km — nearest is Cineplex Cinemas Yonge-Dundas and VIP (7130)
  ok   movies: 250 in catalog
  ok   fuzzy match: "Spider-Man: Brand New Day" -> id 37997 (score 1000)
  ok   showtimes: 95 at Cineplex Cinemas Yonge-Dundas and VIP on 2026-07-31 — sampling 2026-07-31T19:10:00 (UltraAVX 3D D-BOX Dolby Atmos)
  ok   seat map: 15 rows, 387 seats
  ok   scoring: 49 available (0 in the preferred zone), best block none

All endpoints healthy.
```

A failure here almost always means something changed upstream — see
`CAPTURE.md`'s "If this breaks in the future" section, which maps each
symptom to its fix. This is deliberately **not** part of CI: pointing
scheduled traffic at an undocumented API would be rude, and an upstream
outage shouldn't redden the build on unrelated commits.

## Architecture

```
src/
  index.js              # MCP server entrypoint; registers tools, thin glue only
  cineplexClient.js     # All HTTP calls to Cineplex's API; caching + throttling
  locationResolver.js   # Postal code / theatre name / city -> lat/lon, for
                        # the cases a caller can't resolve itself. Pure and
                        # offline; no geocoding service. Deliberately narrow —
                        # see "Location input" in the README.
  data/
    postalCodes.json    # Generated: GeoNames FSA centroids (CC BY 4.0).
                        # Rebuild with npm run build:locations.
  seatScoring.js        # Pure functions: normalized seat map -> score. No
                        # network calls, no Cineplex-specific knowledge.
  seatMapAscii.js       # Default visualization: renders raw seat data as the
                        # ASCII/emoji text diagram. Pure, network-free.
  seatMapTemplate.html  # Optional interactive widget UI (CSS + JS): tabs,
                        # showtime chips, pan/zoom seat map, live filters.
                        # Has a JSON-data placeholder, no server logic.
  seatMapTemplate.js    # Loads the .html above and injects real data into it.
                        # Never regenerates the HTML. Also builds the small
                        # widget wrapper that points at the CDN-hosted shell.
test/
  seatScoring.test.js     # Offline unit tests: scoring, ASCII rendering, the
  seatMapAscii.test.js    # client's cache/retry/key-recapture policy, and the
  cineplexClient.test.js  # shell build guards (npm test runs the whole
  shellBuild.test.js      # directory; no network access needed).
scripts/
  smoke.mjs             # Live end-to-end check of all five Cineplex
                        # endpoints (npm run smoke). Not run in CI.
  build-location-data.mjs # Regenerates src/data/postalCodes.json from GeoNames
                        # (npm run build:locations). Documents why the tables
                        # are bundled instead of geocoded at request time.
  build-shell.mjs       # Compiles seatMapTemplate.html into dist/ (npm run
                        # build:shell) so the widget's static CSS/JS can be
                        # served from a CDN instead of re-emitted per request.
  preview-seatmap.mjs   # Local widget preview harness (npm run preview).
.github/
  workflows/test.yml    # Runs npm test on push/PR against Node 18, 20, 22.
dist/
  seatmap-shell.min.js  # Built output of build-shell.mjs; committed so a
  shell-manifest.json   # tagged commit is fetchable via jsDelivr. The
                        # manifest records which SHELL_VERSION the committed
                        # shell belongs to, so a missed bump gets caught.
.claude/
  skills/
    cineplex-seat-map/  # Optional visualization skill: renders
      SKILL.md          # render_seat_map_html's output inline as a widget.
                        # Consumes the server; the server never depends on it.
CAPTURE.md              # Record of how the live endpoints were found, and how
                        # to re-capture them if something changes
RELEASING.md            # Tag scheme (server `v1.0.0` vs widget `widget-vN`)
                        # and the release checklist for each
docs/
  PRD-original.md       # The original build spec. Historical record only —
                        # describes the project as planned, not as built.
```

`seatScoring.js` never sees Cineplex's raw JSON shape — only the normalized
form. `normalizeCineplexSeatMap()` in `cineplexClient.js` is the sole
adapter between the two, so a future Cineplex response-shape change (or a
future non-Cineplex chain) only requires a new adapter, not scoring
changes.

## Non-goals (v1)

- No ticket purchasing — read-only lookups only. Pricing itself isn't even
  fetched; Cineplex doesn't expose it outside its login-gated checkout flow.
- No chains other than Cineplex.
- No persistent database — in-memory cache only. Theatres, movies, and seat
  *layouts* are cached for 24h, bounded at 200 entries with expired-then-
  oldest-first eviction so a long-running server can't grow without limit.
  Seat *availability* is never cached, since it changes as people book and
  abandon carts.
- No login/auth flows. Every endpoint this server calls was confirmed to
  work without one.

## License

MIT — see [`LICENSE`](./LICENSE). This remains an unofficial, personal-use
tool built against Cineplex's undocumented endpoints; see the disclaimer at
the top of this file before relying on it for anything beyond that.

`src/data/postalCodes.json` is derived from the
[GeoNames](https://www.geonames.org/) postal-code dataset, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Project history

[`docs/PRD-original.md`](./docs/PRD-original.md) is the original build spec,
kept as a historical record — it holds the background research (why Fandango
was ruled out, the Open Theatre Seats fallback) and the reasoning behind the
non-goals. It describes the project as planned, **not as built**, and is
marked accordingly; this README is the current documentation.
