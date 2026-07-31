#!/usr/bin/env node
/**
 * MCP server entrypoint. Thin glue only — all Cineplex HTTP logic lives in
 * cineplexClient.js, all seat-scoring logic lives in seatScoring.js.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getTheatres,
  getAllTheatres,
  findMovieByTitle,
  getShowtimes,
  getRawSeatMap,
  normalizeCineplexSeatMap,
  CineplexApiError,
} from "./cineplexClient.js";
import { resolveLocation } from "./locationResolver.js";
import { scoreSeatMap, DEFAULT_SCORE_OPTIONS } from "./seatScoring.js";
import { buildSeatMapWidget, compactRows } from "./seatMapTemplate.js";
import { renderSeatMapAscii, toPastableReply } from "./seatMapAscii.js";

// Prepended to every render_seat_map_ascii result. The client collapses tool
// results behind a "tools used" disclosure, so a diagram that is merely
// returned is a diagram the user never sees — it only lands if the assistant
// reproduces it. Stating that at result-read time, next to the payload it
// applies to, holds up far better than the same words buried in the tool
// description (which is read once, long before the result arrives).
const ASCII_DISPLAY_INSTRUCTION = [
  "⚠️ DISPLAY REQUIRED — the user CANNOT see this tool result. This client hides tool output behind a",
  '"tools used" disclosure they have to click. If you only summarize or describe the seat map, or reply as',
  "though it had been displayed, the user sees nothing.",
  "",
  "Copy the payload below — everything between the two ===== marker lines, excluding the markers themselves —",
  "into your reply, verbatim. Put it wherever it reads best around your prose.",
  "",
  "It is already formatted for you. The diagram sits inside a ``` fence (its column alignment is exact:",
  "re-drawing, re-aligning, re-spacing, translating the emoji, or dropping rows all break it), and the buy",
  "link is already a Markdown link placed outside the fence so it stays clickable. Paste it whole — do not",
  "rebuild it, re-fence it, shorten it, or drop the row-by-row grid. The grid is the entire reason to call",
  "this tool; the recommendation line alone is already available from find_optimal_showtimes and",
  "get_optimal_seats without it.",
].join("\n");

// Cineplex's theatreId/showtimeId are numeric in the API, and that's what
// find_theatres / find_optimal_showtimes hand back — but z.string() rejects
// a bare number, which breaks the natural "pass the previous tool's output
// straight into the next tool" flow an LLM caller does. Accept either.
const idSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

// The version reported in the MCP handshake (and shown by clients) is read
// from package.json rather than duplicated here — one source of truth, so a
// release bump can't leave the client reporting a stale version.
const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const server = new McpServer({
  name: "cineplex-mcp",
  version,
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

/**
 * Report back how a location string was understood, so the caller can tell the
 * user "searching near Toronto, ON" — and, when a bare city name exists in
 * more than one province, say which one was picked and what the others were.
 */
function describeOrigin(origin) {
  return {
    label: origin.label,
    lat: origin.lat,
    lon: origin.lon,
    matchedBy: origin.source,
    precision: origin.precision,
    ...(origin.note ? { note: origin.note } : {}),
    ...(origin.alternatives?.length ? { alsoMatched: origin.alternatives } : {}),
  };
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
      "Find Cineplex theatres near a location, nearest first. Returns id, name, address, and " +
      "distance for each. Give EITHER `lat`/`lon` or `location`. If you already know where the " +
      "place is — most cities, neighbourhoods, landmarks, and street addresses — just send " +
      "lat/lon directly; that is the expected path and needs no lookup. Use `location` for the " +
      "things you cannot resolve reliably: a Canadian postal code, or a Cineplex theatre by name.",
    inputSchema: {
      location: z
        .string()
        .optional()
        .describe(
          'Postal code ("M5B 2H1" or a bare FSA like "M5B"), Cineplex theatre name ' +
            '("Yonge-Dundas"), a city that has a Cineplex theatre ("Mississauga", "London, ON"), ' +
            'or "lat, lon". Canada only. Prefer lat/lon for anywhere you can place yourself.'
        ),
      lat: z.number().optional().describe("Latitude of the search origin (alternative to `location`)"),
      lon: z.number().optional().describe("Longitude of the search origin (alternative to `location`)"),
      rangeKm: z.number().optional().describe("Search radius in kilometers (default 50)"),
    },
  },
  async ({ location, lat, lon, rangeKm }) => {
    try {
      let origin = null;

      if (location !== undefined) {
        // The theatre directory powers theatre-name and city matching. It's a
        // cached call, and a failure there shouldn't sink a lookup the bundled
        // postal table could have answered on its own.
        let directory = [];
        try {
          directory = await getAllTheatres();
        } catch {
          // Fall through with an empty directory — postal codes still resolve.
        }
        const resolved = resolveLocation(location, directory);
        if (!resolved.found) return jsonResult(resolved);
        origin = resolved;
      } else if (lat !== undefined && lon !== undefined) {
        origin = { lat, lon, label: `${lat}, ${lon}`, source: "coordinates", precision: "exact" };
      } else {
        return jsonResult({
          found: false,
          message: "Provide both `lat` and `lon`, or a `location` (postal code, theatre name, or city).",
        });
      }

      const theatres = await getTheatres({ lat: origin.lat, lon: origin.lon, rangeKm });

      if (theatres.length === 0) {
        // Nothing in range. Cineplex always hands back the 15 nearest
        // regardless of radius, so a second wide call costs one request and
        // turns "none found" into "the nearest one is N km away" — the number
        // the caller actually needs in order to pick a new radius.
        let hint = "Try a larger rangeKm, or a nearby larger city.";
        try {
          const wider = await getTheatres({ lat: origin.lat, lon: origin.lon, rangeKm: 10000 });
          const nearest = wider[0];
          const meters = nearest?.location?.distanceToOriginInMeters;
          if (typeof meters === "number") {
            hint =
              `The nearest is ${nearest.theatreName}, ${Math.round(meters / 1000)} km away — ` +
              `pass rangeKm above that to include it.`;
          }
        } catch {
          // Keep the generic hint if the wider lookup fails.
        }
        return jsonResult({
          resolvedLocation: describeOrigin(origin),
          theatres: [],
          message: `No Cineplex theatres within ${rangeKm ?? 50} km of ${origin.label}. ${hint}`,
        });
      }

      return jsonResult({
        resolvedLocation: describeOrigin(origin),
        theatres: theatres.map((t) => {
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
        }),
      });
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
      "Fuzzy-match a movie title against Cineplex's full current catalog (returned in a single response) and return the best match, including the Cineplex movie ID needed by other tools.",
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
      "OPT-IN. Call this ONLY when the user has explicitly asked for an interactive or visual seat map — " +
      "\"make it interactive\", \"visualize it\", \"can I see the seats\". For every other seat or showtime " +
      "question, including \"which showtime should we book\" and \"are there good seats left\", answer in text " +
      "and use render_seat_map_ascii instead; do NOT reach for this tool just because a question involves " +
      "seats. Requires a client that can display inline HTML widgets. " +
      "Given a movie title, theatre, and date, returns a complete, self-contained, already-tested HTML page " +
      "that visualizes real seat availability: theatre header, a showtime picker, a pannable/zoomable " +
      "auditorium seat map, live front-row/side/min-together filter controls, and a stats strip. " +
      "Once called, render the returned HTML inline in the chat as a widget (via the Visualizer's show_widget / " +
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

server.registerTool(
  "render_seat_map_ascii",
  {
    title: "Render a seat map as a text diagram",
    description:
      "THE USER NEVER SEES THIS TOOL'S OUTPUT — the client keeps tool results collapsed behind a 'tools used' " +
      "disclosure. Calling this tool displays nothing on its own; the seat map reaches the user ONLY if you " +
      "paste the payload it returns into your reply. The result arrives already formatted and marked 'COPY " +
      "EVERYTHING BELOW THIS LINE' precisely so that this is copy-paste, not reassembly. " +
      "Given a Cineplex theatre ID and showtime ID (e.g. from find_optimal_showtimes), it returns a compact " +
      "ASCII/emoji seat-map diagram: a centered SCREEN banner, the auditorium as a grid of squares " +
      "(🟩 open, ⬛ taken, 🟪 accessible), the best block of seats for your party highlighted (🟦), and a " +
      "one-line recommendation. THIS IS THE DEFAULT seat map — use it whenever showing the seats helps answer " +
      "a question, and render it as part of your answer rather than asking the user whether they want it. It " +
      "is plain text, so it works in every client with no setup. Only use render_seat_map_html instead when " +
      "the user has explicitly asked for an interactive or visual version. " +
      "Pass theatreName and showLabel through from a prior find_theatres / find_optimal_showtimes result to " +
      "populate the header, and buyUrl from find_optimal_showtimes for an accurate D-BOX-aware link. Set " +
      "monochrome:true for terminals where emoji width misaligns the grid.",
    inputSchema: {
      theatreId: idSchema.describe("Cineplex theatre ID"),
      showtimeId: idSchema.describe("Cineplex showtime ID"),
      partySize: z.number().int().positive().optional().describe("How many seats you want together; the centered block of this size is highlighted. Default 2"),
      excludeFrontRows: z.number().int().nonnegative().optional().describe("Front rows to exclude when choosing the recommended block, default 3"),
      excludeSideSeats: z.number().int().nonnegative().optional().describe("Seats to exclude from each side wall when choosing the recommended block, default 3"),
      monochrome: z.boolean().optional().describe("Use 1-cell ·/▓/+/★ glyphs instead of emoji squares, for terminals where emoji width breaks alignment. Default false"),
      theatreName: z.string().optional().describe("Theatre display name for the header, e.g. from find_theatres"),
      showLabel: z.string().optional().describe("Showtime label for the header, e.g. 'The Odyssey · 7:00 PM IMAX'"),
      buyUrl: z.string().optional().describe("Public 'buy tickets' link for this showtime — pass through find_optimal_showtimes's buyUrl (it carries the correct D-BOX flag). If omitted, a cineplex.com/ticketing/preview link is built from the IDs."),
    },
  },
  async ({ theatreId, showtimeId, partySize, excludeFrontRows, excludeSideSeats, monochrome, theatreName, showLabel, buyUrl }) => {
    const party = partySize ?? 2;
    const scoreOptions = {
      excludeFrontRows: excludeFrontRows ?? DEFAULT_SCORE_OPTIONS.excludeFrontRows,
      excludeSideSeats: excludeSideSeats ?? DEFAULT_SCORE_OPTIONS.excludeSideSeats,
      // A block only counts as a recommendation if the whole party fits together.
      minContiguous: party,
    };
    // Prefer the caller's buyUrl (find_optimal_showtimes builds it with the right
    // dbox flag); otherwise fall back to Cineplex's public preview link — a real
    // www.cineplex.com page that opens without a session token.
    const link =
      buyUrl && buyUrl !== ""
        ? buyUrl
        : `https://www.cineplex.com/ticketing/preview?theatreId=${encodeURIComponent(theatreId)}&showtimeId=${encodeURIComponent(showtimeId)}&dbox=false`;
    try {
      const raw = await getRawSeatMap({ theatreId, showtimeId });
      const normalized = normalizeCineplexSeatMap(raw);
      const { bestBlock } = scoreSeatMap(normalized, scoreOptions);
      const diagram = renderSeatMapAscii(raw, {
        bestBlock,
        partySize: party,
        monochrome: monochrome === true,
        theatreName: theatreName ?? "",
        showLabel: showLabel ?? "",
        buyUrl: link,
      });
      // Two blocks: the display instruction, then the ready-to-paste payload.
      // Splitting them keeps the instruction from being copied along with the
      // diagram, and puts it where the assistant reads it at result time —
      // which lands far more reliably than the tool description alone.
      return {
        content: [
          { type: "text", text: ASCII_DISPLAY_INSTRUCTION },
          { type: "text", text: toPastableReply(diagram) },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
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
