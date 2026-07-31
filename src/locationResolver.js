/**
 * Turns a location string into the `{ lat, lon }` pair Cineplex's theatre
 * search requires — for the cases a caller cannot resolve on its own.
 *
 * This is deliberately narrow. An earlier version bundled a full Canadian
 * gazetteer and parsed street addresses, which duplicated work the calling
 * model already does well: measured on 2026-07-31, Claude converted well-known
 * places to coordinates accurately and extracted the city from an address
 * without help. What it could NOT do reliably was postal codes — 12 of 16
 * sampled FSAs landed within 10 km, but T9K was confidently attributed to Cold
 * Lake when it is Fort McMurray, 264 km away, asserted exactly as firmly as
 * the correct answers. Recall carries no error bar.
 *
 * So the resolver keeps only what world knowledge cannot supply:
 *
 *   1. explicit coordinates      "43.65, -79.38"      (parsed, not looked up)
 *   2. postal code / FSA         "M5B 2H1", "m5b"     bundled table
 *   3. Cineplex theatre name     "Yonge-Dundas"       live theatre directory
 *   4. a city with a theatre     "Mississauga"        live theatre directory
 *
 * Anything else returns `found: false` with a message inviting the caller to
 * pass coordinates instead. That is not a limitation to route around — it is
 * the division of labour: the caller knows where Kensington Market is, and
 * this module knows where T9K is.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ fsa: Record<string,[number,number]> }} */
const DATA = JSON.parse(readFileSync(join(__dirname, "data", "postalCodes.json"), "utf8"));

const PROVINCE_CODES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

const PROVINCE_NAMES = new Map([
  ["alberta", "AB"],
  ["british columbia", "BC"],
  ["manitoba", "MB"],
  ["new brunswick", "NB"],
  ["newfoundland", "NL"],
  ["newfoundland and labrador", "NL"],
  ["northwest territories", "NT"],
  ["nova scotia", "NS"],
  ["nunavut", "NU"],
  ["ontario", "ON"],
  ["prince edward island", "PE"],
  ["quebec", "QC"],
  ["saskatchewan", "SK"],
  ["yukon", "YT"],
]);

/** Case/punctuation/accent-insensitive key: "St. John's" -> "st john s". */
export function normalizePlace(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Parse an explicit coordinate pair: "43.65, -79.38" or "43.65 -79.38".
 * Range-checked, so a bare "2, 3" is not mistaken for a location.
 */
export function parseCoordinates(input) {
  const m = String(input)
    .trim()
    .match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Pull a Canadian postal code (or bare FSA) out of a string.
 *
 * Validated against the bundled table rather than by regex alone: the pattern
 * `[A-Z]\d[A-Z]` also matches unit numbers and fragments of ordinary words,
 * and a false positive silently relocates the search.
 */
export function parsePostalCode(input) {
  const text = String(input).toUpperCase();
  for (const m of text.matchAll(/\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)?\b/g)) {
    if (DATA.fsa[m[1]]) return m[1];
  }
  return null;
}

/**
 * Canada Post puts a "0" in the second position of every rural FSA. Rural ones
 * cover enormous areas — X0A spans the eastern Arctic, and its centroid sits
 * ~1800 km from Iqaluit — so they are reported as regions, not points. Urban
 * FSAs are a few blocks and need no such caveat.
 */
function isRuralFsa(code) {
  return code[1] === "0";
}

/** Split a trailing province off a place string: "London ON" -> ["London","ON"]. */
function splitProvince(text) {
  const trimmed = String(text).trim().replace(/,\s*canada$/i, "");
  const codeMatch = trimmed.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (codeMatch && PROVINCE_CODES.has(codeMatch[2].toUpperCase())) {
    return [codeMatch[1].trim(), codeMatch[2].toUpperCase()];
  }
  const normalized = normalizePlace(trimmed);
  for (const [name, code] of PROVINCE_NAMES) {
    if (normalized.endsWith(` ${name}`)) {
      return [trimmed.slice(0, trimmed.length - name.length).replace(/[,\s]+$/, "").trim(), code];
    }
  }
  return [trimmed, null];
}

/** Coordinates for a Cineplex theatre directory entry, or null. */
function theatreCoords(theatre) {
  const geo = theatre?.location?.geoLocation;
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return null;
  return { lat: geo.latitude, lon: geo.longitude };
}

/**
 * Match a query against theatre names. Cineplex names are long and branded
 * ("Cineplex Cinemas Yonge-Dundas and VIP"), so people type fragments —
 * substring containment on the normalized form, preferring the shortest match.
 */
function matchTheatreName(query, theatres) {
  const q = normalizePlace(query);
  if (q.length < 3) return null;

  let best = null;
  for (const theatre of theatres) {
    const coords = theatreCoords(theatre);
    if (!coords) continue;
    const full = normalizePlace(theatre.theatreName ?? "");
    const short = normalizePlace(theatre.shortTheatreName ?? "");
    if (!full && !short) continue;

    let score = null;
    if (full === q || short === q) score = 0;
    else if (short.includes(q)) score = short.length - q.length + 1;
    else if (full.includes(q)) score = full.length - q.length + 100;
    if (score === null) continue;

    if (!best || score < best.score) best = { score, theatre, coords };
  }
  return best;
}

/**
 * Cities that have a Cineplex theatre, keyed "city|PROVINCE", at the centroid
 * of their theatres. Built from the live directory, so it needs no bundled
 * data and stays correct as Cineplex opens and closes locations.
 */
function citiesFromTheatres(theatres) {
  const acc = new Map();
  for (const theatre of theatres) {
    const coords = theatreCoords(theatre);
    const city = theatre?.location?.city;
    const province = theatre?.location?.provinceCode;
    if (!coords || !city || !province) continue;
    const key = `${normalizePlace(city)}|${province}`;
    const entry = acc.get(key) ?? { lat: 0, lon: 0, n: 0, city };
    entry.lat += coords.lat;
    entry.lon += coords.lon;
    entry.n++;
    acc.set(key, entry);
  }
  const out = new Map();
  for (const [key, e] of acc) {
    out.set(key, { lat: e.lat / e.n, lon: e.lon / e.n, city: e.city });
  }
  return out;
}

function result({ lat, lon, label, source, precision, alternatives }) {
  return {
    found: true,
    lat: Math.round(lat * 10000) / 10000,
    lon: Math.round(lon * 10000) / 10000,
    label,
    source,
    precision,
    ...(alternatives?.length ? { alternatives } : {}),
  };
}

const UNRESOLVED =
  "Pass `lat`/`lon` instead if you know the coordinates, or use a postal code " +
  '("M5B 2H1"), a Cineplex theatre name, or a city that has a Cineplex theatre.';

function notFound(message) {
  return { found: false, message };
}

/**
 * Resolve a location string to coordinates.
 *
 * @param {string|{lat:number,lon:number}} input
 * @param {object[]} [theatres] Cineplex theatre directory (getAllTheatres()).
 *   Without it, only coordinates and postal codes resolve.
 * @returns {{found:true,lat:number,lon:number,label:string,source:string,precision:string,alternatives?:string[]}
 *          |{found:false,message:string}}
 */
export function resolveLocation(input, theatres = []) {
  if (input && typeof input === "object") {
    const { lat, lon } = input;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return result({ lat, lon, label: `${lat}, ${lon}`, source: "coordinates", precision: "exact" });
    }
    return notFound("Expected a location string, or an object with numeric lat and lon.");
  }

  const raw = String(input ?? "").trim();
  if (!raw) return notFound(`No location given. ${UNRESOLVED}`);

  // 1. Explicit coordinates.
  const coords = parseCoordinates(raw);
  if (coords) {
    return result({ ...coords, label: raw, source: "coordinates", precision: "exact" });
  }

  // 2. Postal code, anywhere in the string — so a full address still resolves
  //    when it carries one. This is the case world knowledge gets wrong.
  const fsa = parsePostalCode(raw);
  if (fsa) {
    const [lat, lon] = DATA.fsa[fsa];
    return result({
      lat,
      lon,
      label: `${fsa} (postal code area)`,
      source: "postal-code",
      precision: isRuralFsa(fsa) ? "region" : "fsa",
    });
  }

  // 3. A city that has a Cineplex theatre.
  //
  //    Checked before theatre names because Cineplex names many theatres after
  //    their city ("Scotiabank Theatre Toronto"), so a bare "Toronto" would
  //    otherwise substring-match one building instead of the city.
  const [placePart, province] = splitProvince(raw);
  const cityKey = normalizePlace(placePart);
  if (cityKey) {
    const hit = lookupCity(cityKey, province, citiesFromTheatres(theatres));
    if (hit) return hit;
  }

  // 4. A Cineplex theatre by name.
  const theatreMatch = matchTheatreName(raw, theatres);
  if (theatreMatch) {
    return result({
      ...theatreMatch.coords,
      label: theatreMatch.theatre.theatreName,
      source: "theatre-name",
      precision: "exact",
    });
  }

  return notFound(`Could not resolve "${raw}". ${UNRESOLVED}`);
}

/** City lookup against the theatre directory, with province disambiguation. */
function lookupCity(cityKey, province, theatreCities) {
  if (province) {
    const hit = theatreCities.get(`${cityKey}|${province}`);
    if (!hit) return null;
    return result({
      lat: hit.lat,
      lon: hit.lon,
      label: `${hit.city}, ${province}`,
      source: "cineplex-city",
      precision: "city",
    });
  }

  const prefix = `${cityKey}|`;
  const provinces = [...theatreCities.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  if (provinces.length === 0) return null;

  const [chosen, ...rest] = provinces;
  const hit = theatreCities.get(`${cityKey}|${chosen}`);
  return result({
    lat: hit.lat,
    lon: hit.lon,
    label: `${hit.city}, ${chosen}`,
    source: "cineplex-city",
    precision: "city",
    alternatives: rest.map((p) => `${hit.city}, ${p}`),
  });
}
