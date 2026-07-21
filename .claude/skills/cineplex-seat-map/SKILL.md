---
name: cineplex-seat-map
description: Use whenever the user asks about Cineplex movie showtimes, ticket availability, or seat selection and a visual seat map would help — e.g. "find IMAX showtimes with good seats", "show me the seat map for this showtime", "are there good seats left for The Odyssey tonight". Always renders as an inline widget, never a file artifact.
---

# Cineplex seat map

When a Cineplex ticketing/seat question calls for a visual, use the
`cineplex` MCP server's `render_seat_map_html` tool and render its result
inline via the Visualizer's `show_widget` tool — never as a file, never
opened in a browser or any external viewer.

## Procedure

1. Resolve whatever `render_seat_map_html` needs (`movieTitle`, `theatreId`,
   `date`) — call `find_theatres` first if you don't already have a
   `theatreId`, and pass its `name`/`address`/`distanceKm` straight through
   as `theatreName`/`theatreAddress`/`distanceKm` so the tool doesn't need a
   second lookup.
2. Call `render_seat_map_html`. It returns one complete, self-contained,
   already-tested HTML page as plain text — theatre header, showtime chips,
   a pannable/zoomable seat map, live filter controls, and a stats strip.
3. If you haven't called `visualize:read_me` (module: `"interactive"`) yet
   this conversation, call it once before your first `show_widget` call —
   this is a requirement of the Visualizer itself, not optional.
4. **Take that exact HTML and pass it directly into the Visualizer's
   `show_widget` tool as the `widget_code` parameter** — the same way you
   would if the user had pasted that HTML directly into the chat and asked
   you to preview it. Do not:
   - write it to a file or use any file-creation/save tool (e.g. `create_file`
     + `present_files`)
   - open it in a browser or any external/preview surface
   - rewrite, regenerate, paraphrase, or "clean up" the HTML before passing
     it to `widget_code` — the template is already built and tested; your
     only job is to pass its output through unmodified
   - summarize its contents as plain text instead of showing it
5. After the widget appears, a short one- or two-sentence note is fine
   (e.g. what showtime it's showing, whether seats look good) — but the
   widget itself is the answer, not a supplement to a text answer.

## Why this matters

`render_seat_map_html` exists specifically so Claude never hand-writes new
seat-map UI code per request — that risks shipping a fresh bug every time
(this happened once already: a freshly-generated artifact had a JS error
that made every button/drag unresponsive). The tool always returns the same
known-good, already-tested template with real data injected in. Treating
its output as "a file to save" defeats the entire purpose — the value is in
showing the *live, interactive* page, not producing a document about it.

Delivery via `show_widget`/`widget_code` is newer and less proven than the
file-artifact path this skill used before. If seat-map rendering ever looks
broken or stops appearing inline, this delivery step is the first place to
check — confirm `visualize:read_me` was called, confirm `widget_code` is
receiving the raw HTML unmodified, and confirm nothing upstream silently
fell back to file creation.
