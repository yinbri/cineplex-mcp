/**
 * Pure seat-scoring logic. No network calls, no knowledge of Cineplex's raw
 * JSON shape — operates only on the normalized seat map shape:
 *
 *   {
 *     rows: [
 *       { row: string, seats: [ { number: number, status: "available"|"sold"|"companion"|"other", aisle: boolean } ] }
 *     ]
 *   }
 *
 * Rows are ordered front-to-back. Chain-specific adapters (e.g.
 * normalizeCineplexSeatMap in cineplexClient.js) are responsible for
 * converting a vendor's raw response into this shape.
 */

/**
 * Order seat labels by their trailing number ("A9" before "A10"), falling back
 * to plain string order for labels that don't end in digits.
 */
export function bySeatNumber(a, b) {
  const numOf = (s) => {
    const m = /(\d+)\s*$/.exec(String(s));
    return m ? Number(m[1]) : NaN;
  };
  const na = numOf(a);
  const nb = numOf(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
  return na - nb;
}

export const DEFAULT_SCORE_OPTIONS = {
  excludeFrontRows: 3,
  excludeSideSeats: 3,
  minContiguous: 1,
};

/**
 * Score a normalized seat map against exclusion rules.
 *
 * @param {{ rows: Array<{ row: string, seats: Array<{ number: number, status: string, aisle?: boolean }> }> }} seatMap
 * @param {{ excludeFrontRows?: number, excludeSideSeats?: number, minContiguous?: number }} [options]
 * @returns {{
 *   hasOptimalSeats: boolean,
 *   optimalAvailable: number,
 *   bestBlock: { row: string, startSeat: number, length: number } | null,
 *   totalAvailable: number,
 * }}
 */
export function scoreSeatMap(seatMap, options = {}) {
  const {
    excludeFrontRows = DEFAULT_SCORE_OPTIONS.excludeFrontRows,
    excludeSideSeats = DEFAULT_SCORE_OPTIONS.excludeSideSeats,
    minContiguous = DEFAULT_SCORE_OPTIONS.minContiguous,
  } = options;

  const rows = Array.isArray(seatMap?.rows) ? seatMap.rows : [];

  // totalAvailable: available seats anywhere in the auditorium, for context.
  let totalAvailable = 0;
  for (const row of rows) {
    for (const seat of row.seats) {
      if (seat.status === "available") totalAvailable++;
    }
  }

  // Step 1: drop the first `excludeFrontRows` rows entirely.
  const eligibleRows = rows.slice(excludeFrontRows);

  let optimalAvailable = 0;
  let bestBlock = null;

  for (const row of eligibleRows) {
    // Step 2: sort by seat number, then trim `excludeSideSeats` from each
    // end *by position within the row*, not by raw seat number — rows can
    // have gaps (aisles, wheelchair spaces, missing numbers), so trimming
    // by index avoids off-by-N errors caused by those gaps.
    const sorted = [...row.seats].sort((a, b) => a.number - b.number);
    const trimmed =
      excludeSideSeats > 0
        ? sorted.slice(excludeSideSeats, sorted.length - excludeSideSeats)
        : sorted;

    if (trimmed.length <= 0) continue;

    for (const seat of trimmed) {
      if (seat.status === "available") optimalAvailable++;
    }

    // Step 3: find contiguous runs of available seats within the trimmed
    // middle section (contiguous by position in the trimmed sequence).
    let runStartIdx = -1;
    let runLength = 0;

    const closeRun = () => {
      if (runLength > 0 && (bestBlock === null || runLength > bestBlock.length)) {
        const seats = trimmed.slice(runStartIdx, runStartIdx + runLength);
        bestBlock = {
          row: row.row,
          startSeat: seats[0].number,
          length: runLength,
          // Printed seat identifiers, when the adapter supplies them. Seat
          // numbering does not have to follow grid position (Cineplex numbers
          // them in the opposite direction), so `startSeat` alone can't be
          // shown to a user as "the seat to ask for". Sorted by trailing seat
          // number so the range reads low-to-high the way a person expects.
          seatLabels: seats.every((s) => s.label != null)
            ? seats.map((s) => s.label).sort(bySeatNumber)
            : null,
        };
      }
      runLength = 0;
      runStartIdx = -1;
    };

    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].status === "available") {
        if (runLength === 0) runStartIdx = i;
        runLength++;
      } else {
        closeRun();
      }
    }
    closeRun();
  }

  return {
    hasOptimalSeats: bestBlock !== null && bestBlock.length >= minContiguous,
    optimalAvailable,
    bestBlock,
    totalAvailable,
  };
}
