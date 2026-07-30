import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizeCineplexSeatMap,
  getShowtimes,
  findMovieByTitle,
} from "../src/cineplexClient.js";
import { scoreSeatMap } from "../src/seatScoring.js";
import { compactRows } from "../src/seatMapTemplate.js";

/**
 * These test the adapter layer — the code that reads Cineplex's raw JSON —
 * against fixtures captured from live responses (see fixtures/README.md).
 *
 * This is the layer the PRD calls out as the single thing that has to change
 * when Cineplex shifts its response shape, so it's the layer most worth
 * pinning down. Everything here is offline: the fixtures ARE the API.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const LAYOUT = fixture("seat-layout.json");
const AVAILABILITY = fixture("seat-availability.json");
const SHOWTIMES = fixture("showtimes.json");
const MOVIES = fixture("movies.json");

describe("normalizeCineplexSeatMap", () => {
  const normalized = normalizeCineplexSeatMap({ layout: LAYOUT, availability: AVAILABILITY });

  test("drops physical gap rows so they can't count as rows", () => {
    // The fixture has a real seatless row (the aisle break between sections).
    // Keeping it would shift every excludeFrontRows calculation by one and
    // silently recommend seats one row off.
    const rawRowCount = LAYOUT.standardSeats.rows.length;
    const gapRows = LAYOUT.standardSeats.rows.filter((r) => r.seats.length === 0).length;

    assert.ok(gapRows > 0, "fixture should contain at least one gap row");
    assert.equal(normalized.rows.length, rawRowCount - gapRows);
    assert.ok(normalized.rows.every((r) => r.seats.length > 0));
  });

  test("maps Cineplex's status vocabulary onto the normalized one", () => {
    // The normalized vocabulary the PRD defines, and the only one
    // seatScoring.js knows how to reason about.
    const statuses = new Set(normalized.rows.flatMap((r) => r.seats.map((s) => s.status)));
    for (const s of statuses) {
      assert.ok(["available", "sold", "companion", "other"].includes(s), `unexpected status ${s}`);
    }

    // The fixture carries all three statuses Cineplex actually returns.
    const raw = Object.values(AVAILABILITY.seatAvailabilities);
    assert.ok(raw.includes("Available") && raw.includes("Occupied") && raw.includes("Broken"));

    const flat = normalized.rows.flatMap((r) => r.seats);
    assert.ok(flat.some((s) => s.status === "available"), "Available -> available");
    assert.ok(flat.some((s) => s.status === "sold"), "Occupied -> sold");
    // A Broken seat is not bookable, but it isn't sold either — it must not be
    // counted as available, which "other" guarantees.
    assert.ok(flat.some((s) => s.status === "other"), "Broken -> other");
  });

  test("marks free accessible seating as companion, not available", () => {
    // Wheelchair/companion spaces are usually empty and sit dead centre, so
    // counting them as available makes them the "best block" for every party
    // that doesn't need them.
    const accessibleRaw = LAYOUT.standardSeats.rows
      .flatMap((r) => r.seats)
      .filter((s) => s.type === "Wheelchair" || s.type === "Companion");
    assert.ok(accessibleRaw.length > 0, "fixture should contain accessible seats");

    const byLabel = new Map(
      normalized.rows.flatMap((r) => r.seats).map((s) => [s.label, s])
    );
    const free = accessibleRaw.filter(
      (s) => String(AVAILABILITY.seatAvailabilities[s.id]).toLowerCase() === "available"
    );
    assert.ok(free.length > 0, "fixture should contain at least one free accessible seat");

    for (const seat of free) {
      assert.equal(byLabel.get(seat.label).status, "companion", `${seat.label} (${seat.type})`);
    }
  });

  test("never recommends accessible seating as the best block", () => {
    const accessibleLabels = new Set(
      LAYOUT.standardSeats.rows
        .flatMap((r) => r.seats)
        .filter((s) => s.type !== "Standard")
        .map((s) => s.label)
    );
    const score = scoreSeatMap(normalized, { excludeFrontRows: 0, excludeSideSeats: 0, minContiguous: 1 });

    for (const label of score.bestBlock?.seatLabels ?? []) {
      assert.ok(!accessibleLabels.has(label), `recommended accessible seat ${label}`);
    }
  });

  test("uses the grid column for geometry and carries the printed label separately", () => {
    // Cineplex numbers seats opposite to grid position: in row A, column 3 is
    // seat A26 and the columns ascend as the seat numbers descend. Scoring
    // needs the column (that's what adjacency means); a human needs the label.
    const rowA = normalized.rows.find((r) => r.row === "A");
    const rawA = LAYOUT.standardSeats.rows.find((r) => r.label === "A");

    assert.deepEqual(
      rowA.seats.map((s) => s.number),
      rawA.seats.map((s) => s.column)
    );
    assert.deepEqual(
      rowA.seats.map((s) => s.label),
      rawA.seats.map((s) => s.label)
    );

    const columns = rowA.seats.map((s) => s.number);
    const seatNumbers = rowA.seats.map((s) => Number(String(s.label).replace(/^\D+/, "")));
    assert.ok(columns[0] < columns[columns.length - 1], "columns ascend");
    assert.ok(seatNumbers[0] > seatNumbers[seatNumbers.length - 1], "seat numbers descend — the reason label is kept");
  });

  test("scoring a real map reports seats by their printed labels", () => {
    const score = scoreSeatMap(normalized, { excludeFrontRows: 0, excludeSideSeats: 0, minContiguous: 2 });

    assert.ok(score.bestBlock, "fixture should have at least one open run");
    assert.ok(Array.isArray(score.bestBlock.seatLabels), "bestBlock should name the actual seats");
    assert.equal(score.bestBlock.seatLabels.length, score.bestBlock.length);
    // Labels read low-to-high the way a person would say them.
    const nums = score.bestBlock.seatLabels.map((l) => Number(String(l).replace(/^\D+/, "")));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  });

  test("survives a response missing the shape it expects", () => {
    assert.deepEqual(normalizeCineplexSeatMap({}).rows, []);
    assert.deepEqual(normalizeCineplexSeatMap({ layout: {}, availability: {} }).rows, []);
  });
});

describe("getShowtimes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const serveFixture = () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => SHOWTIMES,
    });
  };

  const DATE = SHOWTIMES[0].dates[0].startDate.slice(0, 10);
  const THEATRE_ID = SHOWTIMES[0].theatreId;

  test("flattens theatre -> date -> movie -> experience -> session", async () => {
    serveFixture();
    const sessions = await getShowtimes({ theatreId: THEATRE_ID, date: DATE });

    const expected = SHOWTIMES[0].dates[0].movies.flatMap((m) =>
      m.experiences.flatMap((e) => e.sessions)
    ).length;
    assert.equal(sessions.length, expected);
    assert.ok(sessions.every((s) => s.showtimeId !== undefined && s.startTime));
  });

  test("joins experienceTypes into a matchable format string", async () => {
    serveFixture();
    const sessions = await getShowtimes({ theatreId: THEATRE_ID, date: DATE });

    // This is what formatMatch substring-matches against, so "IMAX" and
    // "Dolby" both have to be findable in the same joined string.
    const formats = [...new Set(sessions.map((s) => s.format))];
    assert.ok(formats.some((f) => f.includes("IMAX")), `no IMAX in ${JSON.stringify(formats)}`);
    assert.ok(
      formats.some((f) => f.includes("UltraAVX") && f.includes("Dolby Atmos")),
      "multi-tag experiences should join, not collapse"
    );
  });

  test("filters to one movie when movieId is given", async () => {
    serveFixture();
    const movie = SHOWTIMES[0].dates[0].movies[1];
    const sessions = await getShowtimes({ movieId: movie.id, theatreId: THEATRE_ID, date: DATE });

    assert.ok(sessions.length > 0);
    assert.ok(sessions.every((s) => String(s.movieId) === String(movie.id)));
  });

  test("returns nothing for a date the response doesn't cover", async () => {
    serveFixture();
    assert.deepEqual(await getShowtimes({ theatreId: THEATRE_ID, date: "1999-01-01" }), []);
  });

  test("builds a public buy link that preserves the D-BOX flag", async () => {
    serveFixture();
    const sessions = await getShowtimes({ theatreId: THEATRE_ID, date: DATE });

    for (const s of sessions) {
      const url = new URL(s.buyUrl);
      assert.equal(url.origin + url.pathname, "https://www.cineplex.com/ticketing/preview");
      assert.equal(url.searchParams.get("theatreId"), String(THEATRE_ID));
      assert.equal(url.searchParams.get("showtimeId"), String(s.showtimeId));
    }

    // The fixture includes a D-BOX session; its flag has to survive, or the
    // link lands on the wrong ticket type.
    const dbox = sessions.filter((s) => /dbox=true/i.test(s.buyUrl));
    assert.ok(dbox.length > 0, "expected at least one D-BOX session in the fixture");
    assert.ok(dbox.every((s) => s.format.includes("D-BOX")));
  });
});

describe("findMovieByTitle", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // getAllMovies caches for the process, so one stub serves every case here.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    json: async () => MOVIES,
  });

  const titleOf = (best) => best.match.name ?? best.match.title;
  const SAMPLE = MOVIES.items[0].name;

  test("matches an exact title", async () => {
    const best = await findMovieByTitle(SAMPLE);
    assert.equal(titleOf(best), SAMPLE);
    assert.ok(best.match.id);
  });

  test("ignores case and punctuation", async () => {
    const mangled = SAMPLE.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    assert.equal(titleOf(await findMovieByTitle(mangled)), SAMPLE);
  });

  test("matches a leading substring of the title", async () => {
    const prefix = SAMPLE.split(" ").slice(0, 2).join(" ");
    assert.equal(titleOf(await findMovieByTitle(prefix)), SAMPLE);
  });

  test("tolerates a typo", async () => {
    const typo = SAMPLE.slice(0, -1) + "x";
    const best = await findMovieByTitle(typo);
    assert.ok(best, "a one-character typo should still match");
    assert.equal(titleOf(best), SAMPLE);
  });

  test("returns null rather than a bad guess for an unrelated title", async () => {
    assert.equal(await findMovieByTitle("zzzzqqqq not a real film xyzzy"), null);
  });
});

describe("compactRows <-> the widget's inflate()", () => {
  /**
   * compactRows shrinks seat data ~7x for the wire; the template's inflate()
   * reverses it in the browser. The two implementations live in different
   * files and different languages-of-context, with only a comment asking them
   * not to drift. This runs the real inflate() against the real compactRows
   * so drift fails a test instead of silently breaking the widget.
   */
  const templateHtml = readFileSync(join(__dirname, "..", "src", "seatMapTemplate.html"), "utf8");
  const source = /function inflate\(data\)\s*\{[\s\S]*?\n  \}/.exec(templateHtml);

  test("inflate() can still be located in the template", () => {
    assert.ok(source, "inflate() not found in seatMapTemplate.html — the round-trip test needs updating");
  });

  test("a real seat map survives a compact -> inflate round trip", () => {
    const inflate = new Function(`${source[0]}; return inflate;`)();

    const rawRows = LAYOUT.standardSeats.rows;
    const availability = AVAILABILITY.seatAvailabilities;
    const compacted = compactRows(rawRows, availability);
    const restored = inflate({
      theatres: [{ sessions: [{ r: JSON.parse(JSON.stringify(compacted)) }] }],
    }).theatres[0].sessions[0];

    assert.equal(restored.rawRows.length, rawRows.length, "row count must survive");

    for (const [i, row] of rawRows.entries()) {
      const back = restored.rawRows[i];
      assert.equal(back.label, row.label ?? null, `row ${i} label`);
      assert.deepEqual(
        back.seats.map((s) => s.column),
        row.seats.map((s) => s.column),
        `row ${i} columns`
      );
      assert.deepEqual(
        back.seats.map((s) => s.label),
        row.seats.map((s) => s.label ?? null),
        `row ${i} seat labels`
      );
      assert.deepEqual(
        back.seats.map((s) => s.type),
        row.seats.map((s) => s.type),
        `row ${i} seat types (Wheelchair/Companion must not degrade to Standard)`
      );
      // Availability is re-keyed to synthetic ids, so compare by position.
      assert.deepEqual(
        back.seats.map((s) => restored.availability[s.id] === "available"),
        row.seats.map((s) => String(availability[s.id]).toLowerCase() === "available"),
        `row ${i} availability`
      );
    }
  });
});
