# Test fixtures

Real Cineplex API responses, captured live and trimmed. They exist so the
adapter layer — the code that reads Cineplex's raw JSON — can be tested
offline against shapes Cineplex actually returns, rather than shapes we
imagined.

Captured **2026-07-30** from Cineplex Cinemas Yonge-Dundas (theatre `7130`).

| File | Endpoint |
|---|---|
| `seat-layout.json` | `ticketing/api/v1/theatre/7130/showtime/441689/seat-layout` |
| `seat-availability.json` | `…/seat-availability` |
| `showtimes.json` | `theatrical/api/v1/showtimes?locationId=7130&date=…` |
| `movies.json` | `theatrical/api/v1/movies?language=en` |

## What was trimmed, and what wasn't

Trimmed for size: row and seat counts, session counts, and the movie catalog
(12 of 258). `movies.json` also keeps only the fields the matcher reads.

**Field names and value vocabularies are untouched.** That's the whole point
— a fixture with invented field names would pass tests while the real
adapter broke.

The seat-map fixture was chosen to keep every awkward case the real
auditorium contains:

- a **seatless row** — the physical aisle break between sections, which must
  not count as a row for `excludeFrontRows`
- **`Wheelchair` and `Companion`** seat types alongside `Standard`
- all three availability values Cineplex returns: `Available`, `Occupied`,
  and **`Broken`** (a real status that is neither bookable nor sold)
- **non-contiguous columns** — rows start at different columns, so
  side-trimming by index rather than seat number is exercised
- **seat labels that run opposite to columns** — column 3 is seat `A26`,
  column 28 is `A1`

That last one is why `label` is carried through the normalized shape: the
column is a grid coordinate, not the number printed on the ticket.

## Re-capturing

These are a snapshot; showtimes for a past date are naturally stale, which is
fine — the tests assert on structure, not on today's schedule. If Cineplex
changes its response shape, re-capture with the URLs above (see `CAPTURE.md`
for how the endpoints and the subscription key are obtained) and re-trim to
preserve the cases listed above.
