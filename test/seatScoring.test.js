import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreSeatMap } from "../src/seatScoring.js";

/**
 * Builds a synthetic auditorium: `rowCount` rows (labelled A, B, C, ...),
 * each with `seatsPerRow` seats numbered 1..seatsPerRow, all "available"
 * by default. `overrides` is a map of "ROW-NUMBER" -> status, applied on
 * top of the default. Passing null for a seat's status removes that seat
 * entirely (simulating a gap, e.g. a missing/wheelchair position).
 */
function buildAuditorium(rowCount, seatsPerRow, overrides = {}) {
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const rowLabel = String.fromCharCode(65 + r); // A, B, C...
    const seats = [];
    for (let n = 1; n <= seatsPerRow; n++) {
      const key = `${rowLabel}-${n}`;
      const status = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : "available";
      if (status === null) continue; // simulate a gap
      seats.push({ number: n, status, aisle: false });
    }
    rows.push({ row: rowLabel, seats });
  }
  return { rows };
}

describe("scoreSeatMap - front row exclusion", () => {
  test("drops the first N rows entirely from consideration", () => {
    const map = buildAuditorium(10, 12);
    const result = scoreSeatMap(map, {
      excludeFrontRows: 3,
      excludeSideSeats: 0,
      minContiguous: 1,
    });
    // Row A (index 0) sold out shouldn't matter since it's excluded either way,
    // but let's prove exclusion directly: sell out everything except row A.
    const mapOnlyFrontOpen = buildAuditorium(10, 12);
    for (const row of mapOnlyFrontOpen.rows) {
      if (row.row !== "A") {
        for (const seat of row.seats) seat.status = "sold";
      }
    }
    const excluded = scoreSeatMap(mapOnlyFrontOpen, {
      excludeFrontRows: 3,
      excludeSideSeats: 0,
      minContiguous: 1,
    });
    assert.equal(excluded.hasOptimalSeats, false);
    assert.equal(excluded.bestBlock, null);
    assert.equal(excluded.optimalAvailable, 0);
    // totalAvailable still counts row A's seats even though excluded from scoring.
    assert.equal(excluded.totalAvailable, 12);

    assert.equal(result.totalAvailable, 120);
  });

  test("excludeFrontRows = 0 makes every row eligible", () => {
    const map = buildAuditorium(5, 12);
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 0,
      minContiguous: 1,
    });
    assert.equal(result.hasOptimalSeats, true);
    assert.equal(result.bestBlock.row, "A");
  });
});

describe("scoreSeatMap - side seat exclusion with row gaps", () => {
  test("trims by position within the row, not by raw seat number", () => {
    // Row with a gap at seat 2 (e.g. a wheelchair space removed from the map).
    // Seats present: 1, 3, 4, 5, 6, 7, 8, 9, 10 (9 seats, numbers have a hole at 2).
    const overrides = { "A-2": null };
    const map = buildAuditorium(1, 10, overrides);
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 2,
      minContiguous: 1,
    });
    // Positions (0-indexed): [1,3,4,5,6,7,8,9,10] -> trim 2 from each end
    // -> remaining positions are seat numbers [4,5,6,7,8] (index 2..6).
    assert.equal(result.bestBlock.length, 5);
    assert.equal(result.bestBlock.startSeat, 4);
  });

  test("excludeSideSeats trims correctly with no gaps", () => {
    const map = buildAuditorium(1, 12);
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 3,
      minContiguous: 1,
    });
    // Seats 1-12, trim 3 from each end -> seats 4..9 eligible (6 seats).
    assert.equal(result.bestBlock.startSeat, 4);
    assert.equal(result.bestBlock.length, 6);
    assert.equal(result.optimalAvailable, 6);
  });
});

describe("scoreSeatMap - contiguous run detection", () => {
  test("finds the longest contiguous available run across eligible rows", () => {
    const map = buildAuditorium(5, 12);
    // Row D (index 3, eligible after excluding 3 front rows) gets a long run;
    // sell everything else in eligible rows except a short run in row E.
    for (const row of map.rows) {
      if (row.row === "D") {
        for (const seat of row.seats) {
          seat.status = seat.number >= 4 && seat.number <= 9 ? "available" : "sold";
        }
      } else if (row.row === "E") {
        for (const seat of row.seats) {
          seat.status = seat.number === 5 || seat.number === 6 ? "available" : "sold";
        }
      }
    }
    const result = scoreSeatMap(map, {
      excludeFrontRows: 3,
      excludeSideSeats: 3,
      minContiguous: 1,
    });
    assert.equal(result.bestBlock.row, "D");
    assert.equal(result.bestBlock.length, 6);
    assert.equal(result.bestBlock.startSeat, 4);
  });

  test("a run broken by a sold seat counts as two separate runs", () => {
    const map = buildAuditorium(1, 12);
    // Middle zone after trimming 3/3 is seats 4..9. Sell seat 6 to split the run.
    for (const seat of map.rows[0].seats) {
      if (seat.number === 6) seat.status = "sold";
    }
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 3,
      minContiguous: 1,
    });
    // Runs: [4,5] length 2, [7,8,9] length 3 -> best is length 3 starting at 7.
    assert.equal(result.bestBlock.length, 3);
    assert.equal(result.bestBlock.startSeat, 7);
  });
});

describe("scoreSeatMap - minContiguous parameter", () => {
  test("requesting 2 adjacent seats fails when only single seats are free", () => {
    const map = buildAuditorium(1, 12);
    // Middle zone (4..9): sell every other seat so nothing is adjacent.
    for (const seat of map.rows[0].seats) {
      if (seat.number >= 4 && seat.number <= 9 && seat.number % 2 === 1) {
        seat.status = "sold";
      }
    }
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 3,
      minContiguous: 2,
    });
    assert.equal(result.hasOptimalSeats, false);
    // bestBlock still reports the best available run found (length 1), even
    // though it doesn't clear the minContiguous bar.
    assert.equal(result.bestBlock.length, 1);
  });

  test("requesting 2 adjacent seats succeeds when a pair is free", () => {
    const map = buildAuditorium(1, 12);
    for (const seat of map.rows[0].seats) {
      if (seat.number >= 4 && seat.number <= 9) {
        seat.status = seat.number === 5 || seat.number === 6 ? "available" : "sold";
      }
    }
    const result = scoreSeatMap(map, {
      excludeFrontRows: 0,
      excludeSideSeats: 3,
      minContiguous: 2,
    });
    assert.equal(result.hasOptimalSeats, true);
    assert.equal(result.bestBlock.length, 2);
    assert.equal(result.bestBlock.startSeat, 5);
  });

  test("no available seats anywhere yields hasOptimalSeats false and null bestBlock", () => {
    const map = buildAuditorium(10, 12);
    for (const row of map.rows) {
      for (const seat of row.seats) seat.status = "sold";
    }
    const result = scoreSeatMap(map);
    assert.equal(result.hasOptimalSeats, false);
    assert.equal(result.bestBlock, null);
    assert.equal(result.optimalAvailable, 0);
    assert.equal(result.totalAvailable, 0);
  });
});

describe("scoreSeatMap - default options", () => {
  test("defaults match PRD (excludeFrontRows=3, excludeSideSeats=3, minContiguous=1)", () => {
    const map = buildAuditorium(10, 12);
    const result = scoreSeatMap(map, {});
    // Rows A-C excluded, seats trimmed to positions 4..9 (6 seats) per row,
    // all available -> best run is 6 seats in row D (first eligible row).
    assert.equal(result.hasOptimalSeats, true);
    assert.equal(result.bestBlock.row, "D");
    assert.equal(result.bestBlock.length, 6);
  });
});
