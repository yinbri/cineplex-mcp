#!/usr/bin/env node
/**
 * MCP server entrypoint. Thin glue only — all Cineplex HTTP logic lives in
 * cineplexClient.js, all seat-scoring logic lives in seatScoring.js.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getTheatres,
  findMovieByTitle,
  getShowtimes,
  getRawSeatMap,
  normalizeCineplexSeatMap,
  CineplexApiError,
} from "./cineplexClient.js";
import { scoreSeatMap, DEFAULT_SCORE_OPTIONS } from "./seatScoring.js";
import { buildSeatMapWidget, compactRows } from "./seatMapTemplate.js";

// Cineplex's theatreId/showtimeId are numeric in the API, and that's what
// find_theatres / find_optimal_showtimes hand back — but z.string() rejects
// a bare number, which breaks the natural "pass the previous tool's output
// straight into the next tool" flow an LLM caller does. Accept either.
const idSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

const server = new McpServer({
  name: "cineplex-mcp",
  version: "0.1.0",
});

function errorResult(err) {
  const message = err instanceof CineplexApiError ? err.message : `Unexpected error: ${err.message}`;
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function htmlResult(html) {
  return { content: [{ type: "text", text: html }] };
}

/** Fetch + normalize + score one showtime's seat map. Never throws. */
async function scoreShowtime({ theatreId, showtimeId }, scoreOptions) {
  try {
    const raw = await getRawSeatMap({ theatreId, showtimeId });
    const normalized = normalizeCineplexSeatMap(raw);
    return { theatreId, showtimeId, ...scoreSeatMap(normalized, scoreOptions) };
  } catch (err) {
    const message = err instanceof CineplexApiError ? err.message : `Unexpected error: ${err.message}`;
    return { theatreId, showtimeId, error: message };
  }
}

server.registerTool(
  "find_theatres",
  {
    title: "Find Cineplex theatres",
    description:
      "Find Cineplex theatres near a location (by lat/lon and search radius). Returns id, name, address, and distance for each theatre.",
    inputSchema: {
      lat: z.number().describe("Latitude of the search origin"),
      lon: z.number().describe("Longitude of the search origin"),
      rangeKm: z.number().optional().describe("Search radius in kilometers (default 50)"),
    },
  },
  async ({ lat, lon, rangeKm }) => {
    try {
      const theatres = await getTheatres({ lat, lon, rangeKm });
      return jsonResult(
        theatres.map((t) => {
          const loc = t.location ?? {};
          const cityProvince = [loc.city, loc.provinceCode].filter(Boolean).join(" ");
          const address = [loc.address, [cityProvince, loc.postalCode].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(", ");
          return {
            id: t.theatreId,
            name: t.theatreName,
            address,
            distanceKm: loc.distanceToOriginInMeters !== undefined
              ? Math.round(loc.distanceToOriginInMeters / 100) / 10
              : undefined,
          };
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "find_movie",
  {
    title: "Find a Cineplex movie by title",
    description:
      "Fuzzy-match a movie title against Cineplex's current catalog (pages through all results) and return the best match, including the Cineplex movie ID needed by other tools.",
    inputSchema: {
      title: z.string().describe("Movie title to search for, e.g. 'The Odyssey'"),
    },
  },
  async ({ title }) => {
    try {
      const best = await findMovieByTitle(title);
      if (!best) {
        return jsonResult({ found: false, message: `No movie matching "${title}" was found in Cineplex's current catalog.` });
      }
      return jsonResult({
        found: true,
        movieId: best.match.id ?? best.match.movieId,
        title: best.match.title ?? best.match.name,
        matchScore: best.score,
        raw: best.match,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "find_optimal_showtimes",
  {
    title: "Find optimal Cineplex showtimes",
    description:
      "Given a movie title, theatre, and date, find showtimes matching a format (default IMAX) and check which ones have good seats available (not front rows, not sides, with a contiguous block big enough for your group).",
    inputSchema: {
      movieTitle: z.string().describe("Movie title, e.g. 'The Odyssey'"),
      theatreId: idSchema.describe("Cineplex theatre ID, from find_theatres"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
      formatMatch: z.string().optional().describe("Case-insensitive substring to match against the showtime's format/experience tag, default 'IMAX'"),
      excludeFrontRows: z.number().int().nonnegative().optional().describe("Number of front rows to exclude, default 3"),
      excludeSideSeats: z.number().int().nonnegative().optional().describe("Number of seats to exclude from each side wall, default 3"),
      minContiguous: z.number().int().positive().optional().describe("Minimum contiguous open seats required, default 1"),
    },
  },
  async ({ movieTitle, theatreId, date, formatMatch = "IMAX", excludeFrontRows, excludeSideSeats, minContiguous }) => {
    const scoreOptions = {
      excludeFrontRows: excludeFrontRows ?? DEFAULT_SCORE_OPTIONS.excludeFrontRows,
      excludeSideSeats: excludeSideSeats ?? DEFAULT_SCORE_OPTIONS.excludeSideSeats,
      minContiguous: minContiguous ?? DEFAULT_SCORE_OPTIONS.minContiguous,
    };

    try {
      const best = await findMovieByTitle(movieTitle);
      if (!best) {
        return jsonResult({ found: false, message: `No movie matching "${movieTitle}" was found in Cineplex's current catalog.` });
      }
      const movieId = best.match.id ?? best.match.movieId;

      let sessions;
      try {
        sessions = await getShowtimes({ movieId, theatreId, date });
      } catch (err) {
        return errorResult(err);
      }

      const matching = sessions.filter((s) =>
        String(s.format ?? "").toLowerCase().includes(String(formatMatch).toLowerCase())
      );

      if (matching.length === 0) {
        return jsonResult({
          movieId,
          movieTitle: best.match.title ?? best.match.name,
          formatMatch,
          message: `No showtimes matching format "${formatMatch}" found for this movie/theatre/date.`,
          all: [],
          optimal: [],
        });
      }

      // Score seat maps sequentially (throttled inside cineplexClient) so a
      // single bad fetch never aborts the whole request.
      const scored = [];
      for (const session of matching) {
        const score = await scoreShowtime({ theatreId, showtimeId: session.showtimeId }, scoreOptions);
        scored.push({ ...session, ...score });
      }

      const optimal = scored.filter((s) => s.hasOptimalSeats === true);

      return jsonResult({
        movieId,
        movieTitle: best.match.title ?? best.match.name,
        formatMatch,
        scoreOptions,
        all: scored,
        optimal,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "render_seat_map_html",
  {
    title: "Render an interactive seat map widget",
    description:
      "Given a movie title, theatre, and date, returns a complete, self-contained, already-tested HTML page " +
      "that visualizes real seat availability: theatre header, a showtime picker, a pannable/zoomable " +
      "auditorium seat map, live front-row/side/min-together filter controls, and a stats strip. " +
      "IMPORTANT: render the returned HTML inline in the chat as a widget (via the Visualizer's show_widget / " +
      "widget_code) exactly as given — never save it to a file, publish it as a hosted artifact, or open it in " +
      "a browser. Do not rewrite, regenerate, paraphrase, or modify the code in any way, just pass it through " +
      "verbatim. Pass theatreName/theatreAddress/distanceKm through from a prior find_theatres result if you " +
      "have them, to avoid an extra lookup.",
    inputSchema: {
      movieTitle: z.string().describe("Movie title, e.g. 'The Odyssey'"),
      theatreId: idSchema.describe("Cineplex theatre ID, from find_theatres"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
      theatreName: z.string().optional().describe("Theatre display name, e.g. from find_theatres — defaults to 'Theatre {id}' if omitted"),
      theatreAddress: z.string().optional().describe("Theatre street address, e.g. from find_theatres"),
      distanceKm: z.number().optional().describe("Theatre distance in km, e.g. from find_theatres"),
      formatMatch: z.string().optional().describe("Case-insensitive substring to match against the showtime's format/experience tag, default 'IMAX'"),
      excludeFrontRows: z.number().int().nonnegative().optional().describe("Front rows to exclude in the initial view, default 0 (widget opens unfiltered; the user can adjust it live)"),
      excludeSideSeats: z.number().int().nonnegative().optional().describe("Seats to exclude from each side wall in the initial view, default 0 (widget opens unfiltered; the user can adjust it live)"),
      minContiguous: z.number().int().positive().optional().describe("Minimum contiguous open seats required in the initial view, default 1 (its no-op value)"),
    },
  },
  async ({
    movieTitle,
    theatreId,
    date,
    theatreName,
    theatreAddress,
    distanceKm,
    formatMatch = "IMAX",
    excludeFrontRows,
    excludeSideSeats,
    minContiguous,
  }) => {
    // Unlike the data tools (which default to "good seats" filtering of 3/3/1),
    // the widget opens UNFILTERED — no front rows or side seats excluded — so
    // the user sees the whole auditorium first, then drags the controls to
    // apply their own preferences and watch the best block move. minContiguous
    // stays 1 because that is its no-op value (a block is inherently >= 1 seat).
    // Explicit params still override these.
    const scoreOptions = {
      excludeFrontRows: excludeFrontRows ?? 0,
      excludeSideSeats: excludeSideSeats ?? 0,
      minContiguous: minContiguous ?? 1,
    };

    try {
      const best = await findMovieByTitle(movieTitle);
      if (!best) {
        return jsonResult({ found: false, message: `No movie matching "${movieTitle}" was found in Cineplex's current catalog.` });
      }
      const movieId = best.match.id ?? best.match.movieId;

      let showtimes;
      try {
        showtimes = await getShowtimes({ movieId, theatreId, date });
      } catch (err) {
        return errorResult(err);
      }

      const matching = showtimes.filter((s) =>
        String(s.format ?? "").toLowerCase().includes(String(formatMatch).toLowerCase())
      );

      if (matching.length === 0) {
        return jsonResult({
          movieId,
          movieTitle: best.match.title ?? best.match.name,
          formatMatch,
          message: `No showtimes matching format "${formatMatch}" found for this movie/theatre/date — nothing to render.`,
        });
      }

      // Fetch each matching session's real seat layout + live availability
      // sequentially (throttled inside cineplexClient), same pattern as
      // find_optimal_showtimes. A single bad fetch is dropped, not fatal.
      const sessions = [];
      for (const session of matching) {
        try {
          const { layout, availability } = await getRawSeatMap({ theatreId, showtimeId: session.showtimeId });
          sessions.push({
            showtimeId: session.showtimeId,
            startTime: session.startTime,
            format: session.format,
            auditorium: session.auditorium,
            seatsRemaining: session.seatsRemaining,
            isSoldOut: session.isSoldOut,
            // Cineplex's public "buy tickets" deep link for this session; the
            // widget renders it as a link. onlineEnabled hides the button when
            // Cineplex isn't selling this showtime online.
            buyUrl: session.buyUrl ?? null,
            onlineEnabled: session.isShowtimeEnabledOnline !== false,
            // Compact seat data (see compactRows) — the template's inflate()
            // reconstructs rawRows + availability from this. totalColumns is
            // dropped: the template derives the column range from the seats.
            r: compactRows(layout?.standardSeats?.rows ?? [], availability?.seatAvailabilities ?? {}),
          });
        } catch {
          // Skip sessions whose seat map fails to fetch; the widget only
          // needs the ones that succeeded.
        }
      }

      if (sessions.length === 0) {
        return errorResult(new CineplexApiError("Found matching showtimes, but none of their seat maps could be fetched."));
      }

      const html = buildSeatMapWidget({
        movie: {
          name: best.match.title ?? best.match.name,
          runtimeInMinutes: best.match.runtimeInMinutes,
          genres: best.match.genres,
        },
        date,
        generatedAt: new Date().toISOString(),
        defaultScoreOptions: scoreOptions,
        theatres: [
          {
            id: theatreId,
            name: theatreName ?? `Theatre ${theatreId}`,
            address: theatreAddress ?? "",
            city: "",
            province: "",
            distanceKm: typeof distanceKm === "number" ? distanceKm : null,
            sessions,
          },
        ],
      });

      return htmlResult(html);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_optimal_seats",
  {
    title: "Score seats for a known showtime",
    description:
      "Given a Cineplex theatre ID and showtime ID (e.g. from find_optimal_showtimes), fetch and score its seat map for good seats.",
    inputSchema: {
      theatreId: idSchema.describe("Cineplex theatre ID"),
      showtimeId: idSchema.describe("Cineplex showtime ID"),
      excludeFrontRows: z.number().int().nonnegative().optional().describe("Number of front rows to exclude, default 3"),
      excludeSideSeats: z.number().int().nonnegative().optional().describe("Number of seats to exclude from each side wall, default 3"),
      minContiguous: z.number().int().positive().optional().describe("Minimum contiguous open seats required, default 1"),
    },
  },
  async ({ theatreId, showtimeId, excludeFrontRows, excludeSideSeats, minContiguous }) => {
    const scoreOptions = {
      excludeFrontRows: excludeFrontRows ?? DEFAULT_SCORE_OPTIONS.excludeFrontRows,
      excludeSideSeats: excludeSideSeats ?? DEFAULT_SCORE_OPTIONS.excludeSideSeats,
      minContiguous: minContiguous ?? DEFAULT_SCORE_OPTIONS.minContiguous,
    };
    const result = await scoreShowtime({ theatreId, showtimeId }, scoreOptions);
    if (result.error) {
      return { isError: true, content: [{ type: "text", text: result.error }] };
    }
    return jsonResult(result);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cineplex-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting cineplex-mcp server:", err);
  process.exit(1);
});
