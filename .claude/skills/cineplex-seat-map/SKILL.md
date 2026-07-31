---
name: cineplex-seat-map
description: Use ONLY when the user explicitly asks for an interactive or visual Cineplex seat map — e.g. "make that interactive", "visualize it", "show me the seat map". Do NOT use for ordinary showtime, ticket, or seat-quality questions ("which showtime should we book", "are there good seats left") — answer those in text and call render_seat_map_ascii directly to show the seats, without asking permission first. When this skill does apply, always render as an inline widget, never a file artifact.
---

# Cineplex seat map

When the user has **explicitly asked to see** a Cineplex seat map, use the
`cineplex` MCP server's `render_seat_map_html` tool and render its result
inline via the Visualizer's `show_widget` tool — never as a file, never
opened in a browser or any external viewer.

## When this applies — and when it does not

This skill is **opt-in**. It fires on a request to *see* something, not on
any question that happens to involve seats.

**Use it** when the user asks for the map or for a visual:

- "show me the seat map for that showtime"
- "can I see where the free seats are"
- "make that interactive" / "can you visualize it"
- "is there a better view of this"

**Do not use it** for ordinary ticketing questions, even though they are
about seats. Answer those in text with `find_optimal_showtimes` /
`get_optimal_seats`, and call **`render_seat_map_ascii`** to show the
recommended seats:

- "which showtime should we book?"
- "are there two seats together for The Odyssey tonight?"
- "find IMAX showtimes with good seats near me"
- "what's the best-seated screening this weekend?"

The distinction is what the user asked for. "Which showtime should we book"
is a decision question — the answer is a recommendation, and replacing it
with a widget makes the user do the analysis themselves. The widget is a
richer way to *look*, not a substitute for answering.

**This skill withholds the widget, never the answer.** Do not ask
permission before rendering a text diagram — "would you like me to show it
as a text diagram?" is not a useful turn. Render the ASCII map as part of
the answer, and if the interactive view seems worth offering, say so in a
closing line *after* the answer is already complete.

**Calling `render_seat_map_ascii` does not display anything.** The client
keeps tool results collapsed behind a "tools used" disclosure the user has
to click, so a diagram that was merely returned is a diagram the user never
saw. The result comes back as a display instruction plus a ready-to-paste
payload between `===== COPY ... =====` markers; paste that payload into
your reply verbatim. It is already fenced, already has the buy link outside
the fence — copy it whole rather than rebuilding it.

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

Being opt-in is deliberate. An earlier version of this skill triggered
whenever "a visual seat map would help", which in practice meant every
Cineplex question — so "which showtime should we book?" returned a widget
instead of an answer. Text is the right default: it works in every client
with no setup, it fits a decision question, and it leaves the interactive
view available for when someone actually wants to look at the room.

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
