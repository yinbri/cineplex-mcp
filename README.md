# cineplex-mcp

An MCP (Model Context Protocol) server that lets Claude look up Cineplex
Canada showtimes and find ones with good seats available — e.g. "Find
showtimes for The Odyssey in IMAX 70mm near me with good seats, not the
first 3 rows, not on the sides."

**This is a personal-use tool, not a commercial product.** Cineplex has no
official partner API for this data; this server calls Cineplex's
undocumented public web endpoints directly. It's built to cache
aggressively, keep request volume low, and fail gracefully rather than
pretend otherwise. See `cineplex-mcp-PRD.md` for the full design rationale.

## Status: all four Cineplex data endpoints are confirmed working

All four calls this server depends on hit real, live `apis.cineplex.com`
endpoints, tested end-to-end against real responses as of 2026-07-19. See
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
`cineplexClient.js`; seat data needs no key at all). See `CAPTURE.md` if
that ever changes.

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

## Claude Code configuration

```bash
claude mcp add cineplex -- node /absolute/path/to/cineplex-mcp/src/index.js
```

## Tools exposed

- **`find_theatres`** — `{ lat, lon, rangeKm? }` → nearby theatres (id, name,
  address, distance), sorted by distance.
- **`find_movie`** — `{ title }` → best fuzzy match against Cineplex's
  current movie catalog, including the Cineplex movie ID.
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
- **`render_seat_map_html`** — `{ movieTitle, theatreId, date, theatreName?,
  theatreAddress?, distanceKm?, formatMatch?, excludeFrontRows?,
  excludeSideSeats?, minContiguous? }` → a complete, self-contained HTML page
  visualizing real seat availability: showtime chips, a pannable/zoomable
  auditorium seat map, live filter controls, and a stats strip. Meant to be
  rendered inline in the chat as a widget (via the Visualizer's `show_widget`),
  not saved to a file, published as a hosted artifact, or read as data — see
  `src/seatMapTemplate.html`/`.js`. The tool only injects real data into an
  already-built, already-tested template; it never generates new HTML/JS per
  call, so there's no risk of a fresh generation shipping a UI bug.

- **`render_seat_map_ascii`** — `{ theatreId, showtimeId, partySize?,
  excludeFrontRows?, excludeSideSeats?, monochrome?, theatreName?, showLabel?,
  buyUrl? }`
  → a compact ASCII/emoji seat-map diagram as **plain text**: a centered SCREEN
  banner, the auditorium as a grid of squares (🟩 open, ⬛ taken, 🟪 accessible),
  the best `partySize`-block highlighted (🟦, centered within the run), a
  one-line recommendation, and a trailing `🎟 Buy tickets: <url>` line. The
  lightweight, text-only sibling of `render_seat_map_html` — for when a visual
  helps but an interactive widget is overkill or unavailable (e.g. a plain
  terminal). The seat grid is pasted verbatim into a fenced code block; the buy
  line is kept **out** of the fence and rendered as a clickable Markdown link
  just below it (links don't linkify inside ```). Pass `buyUrl` through from
  `find_optimal_showtimes` for the correct D-BOX-aware link, or omit it to build
  a `cineplex.com/ticketing/preview` link from the IDs. Set `monochrome: true`
  (`·`/`▓`/`+`/`★`) where emoji width misaligns the grid. Rendering logic lives
  in `src/seatMapAscii.js`.

`theatreId`/`showtimeId` accept either a string or a number — Cineplex's IDs
are numeric, and `find_theatres`/`find_optimal_showtimes` hand them back as
numbers, so chaining one tool's output straight into the next one's input
just works.

### Seat-quality parameters

- `excludeFrontRows` (default `3`): drop this many front rows entirely.
- `excludeSideSeats` (default `3`): trim this many seats from each side of
  every remaining row (by position, not raw seat number, so aisle gaps
  don't cause off-by-N errors).
- `minContiguous` (default `1`): require a contiguous block of at least
  this many available seats — set to `2` for a couple, `4` for a group,
  etc.

## Bundled skill: inline seat-map visualization (optional)

This repo ships both an MCP server **and** a Claude skill
([`.claude/skills/cineplex-seat-map`](./.claude/skills/cineplex-seat-map/SKILL.md)).
They serve different jobs, and the dependency only runs one way:

- **The MCP server works on its own.** All five tools return real data as
  plain text/JSON — theatre lists, showtimes, seat scores. You can ask "which
  IMAX showtimes have good seats" or "score seats for this showtime" and get a
  complete answer with no skill involved. `render_seat_map_html` likewise just
  returns a finished HTML string; a client is free to save it, open it, or
  ignore it.
- **The skill is the visualization layer — use it when you want the
  interactive seat map.** Its only job is to take `render_seat_map_html`'s
  output and render it *inline in the chat as a widget* (via the Visualizer's
  `show_widget`) rather than dumping HTML, saving a file, or publishing a
  hosted artifact. It's optional: remove the skill and every tool still works;
  you just render the HTML yourself.

In short: **the server answers the question; the skill draws the picture.**
The skill can't function without this server (it orchestrates these exact
tools), but the server never depends on the skill — which is why they live in
one repo but stay cleanly separable.

## Example prompts

- "Find theatres near me at lat 43.65, lon -79.38."
- "Look up the movie 'The Odyssey' on Cineplex."
- "Find IMAX 70mm showtimes for The Odyssey at theatre 9806 on 2026-07-20
  with good seats, not the first 3 rows or within 3 seats of the wall."
- "Same as above but I need 2 seats together for me and my partner."

## Testing

### Unit tests (no network required)

```bash
npm test
```

Runs `test/seatScoring.test.js` (Node's built-in test runner) against a
synthetic 10-row, 12-seat auditorium, covering front-row exclusion,
side-seat exclusion with row gaps, contiguous-run detection, and the
`minContiguous` parameter.

### Manual smoke test (live endpoints)

```bash
node -e "
import('./src/cineplexClient.js').then(async (c) => {
  const theatres = await c.getTheatres({ lat: 43.6532, lon: -79.3832, rangeKm: 25 });
  console.log('theatres found:', theatres.length, theatres[0]);

  const movie = await c.findMovieByTitle('Dune');
  console.log('best movie match:', movie);
});
"
```

If this returns real data, the caching/throttling/error-handling plumbing
in `cineplexClient.js` is confirmed working end-to-end. A `CineplexApiError`
here means something changed upstream — see `CAPTURE.md`'s "If this breaks
in the future" section.

## Architecture

```
src/
  index.js              # MCP server entrypoint; registers tools, thin glue only
  cineplexClient.js     # All HTTP calls to Cineplex's API; caching + throttling
  seatScoring.js        # Pure functions: normalized seat map -> score. No
                         # network calls, no Cineplex-specific knowledge.
  seatMapTemplate.html  # Self-contained widget UI (CSS + JS): tabs,
                         # showtime chips, pan/zoom seat map, live filters.
                         # Has a JSON-data placeholder, no server logic.
  seatMapTemplate.js    # Loads the .html above and injects real data into
                         # its data placeholder. Never regenerates the HTML.
.claude/
  skills/
    cineplex-seat-map/  # Optional visualization skill: renders
      SKILL.md          # render_seat_map_html's output inline as a widget.
                         # Consumes the server; the server never depends on it.
CAPTURE.md              # Record of how the live endpoints were found, and how
                         # to re-capture them if something changes
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
- No persistent database — in-memory cache only (process lifetime; seat
  availability is never cached, since it changes as people book/abandon
  carts).
- No login/auth flows. Every endpoint this server calls was confirmed to
  work without one.

## License

MIT — see [`LICENSE`](./LICENSE). This remains an unofficial, personal-use
tool built against Cineplex's undocumented endpoints; see the disclaimer at
the top of this file and in `cineplex-mcp-PRD.md` before relying on it for
anything beyond that.
