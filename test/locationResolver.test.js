import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLocation,
  parseCoordinates,
  parsePostalCode,
  normalizePlace,
} from "../src/locationResolver.js";

/**
 * A stand-in Cineplex theatre directory, shaped like the real `/theatres`
 * response (coordinates nested under location.geoLocation). The coordinates
 * are the genuine ones for these theatres, so distance assertions mean
 * something.
 */
const THEATRES = [
  theatre(7130, "Cineplex Cinemas Yonge-Dundas and VIP", "Yonge-Dundas", "Toronto", "ON", 43.6563, -79.3807),
  theatre(7122, "Cineplex Cinemas Courtney Park", "Courtney Park", "Mississauga", "ON", 43.6366, -79.6902),
  theatre(9999, "Scotiabank Theatre Vancouver", "Scotiabank Vancouver", "Vancouver", "BC", 49.2806, -123.1252),
  theatre(8888, "Galaxy Cinemas London", "Galaxy London", "London", "ON", 42.9849, -81.2453),
];

function theatre(theatreId, theatreName, shortTheatreName, city, provinceCode, latitude, longitude) {
  return {
    theatreId,
    theatreName,
    shortTheatreName,
    location: { geoLocation: { latitude, longitude }, city, provinceCode, address: "", postalCode: "" },
  };
}

/** Distance in km, for asserting a result landed in roughly the right place. */
function km(a, b) {
  const dLat = (a.lat - b.lat) * 110.574;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

const TORONTO = { lat: 43.6532, lon: -79.3832 };
const VANCOUVER = { lat: 49.2827, lon: -123.1207 };
const CALGARY = { lat: 51.0447, lon: -114.0719 };

describe("parseCoordinates", () => {
  test("accepts comma- and space-separated pairs", () => {
    assert.deepEqual(parseCoordinates("43.65, -79.38"), { lat: 43.65, lon: -79.38 });
    assert.deepEqual(parseCoordinates("43.65 -79.38"), { lat: 43.65, lon: -79.38 });
    assert.deepEqual(parseCoordinates("  49, -123  "), { lat: 49, lon: -123 });
  });

  test("rejects out-of-range values and non-coordinate text", () => {
    assert.equal(parseCoordinates("91, -79"), null);
    assert.equal(parseCoordinates("43.65, -200"), null);
    assert.equal(parseCoordinates("Toronto"), null);
    assert.equal(parseCoordinates("M5B 2H1"), null);
  });
});

describe("parsePostalCode", () => {
  test("finds a full postal code or bare FSA, in any case", () => {
    assert.equal(parsePostalCode("M5B 2H1"), "M5B");
    assert.equal(parsePostalCode("m5b2h1"), "M5B");
    assert.equal(parsePostalCode("M5B"), "M5B");
  });

  test("finds a postal code embedded in a full address", () => {
    assert.equal(parsePostalCode("123 Front St W, Toronto, ON M5J 2M2"), "M5J");
  });

  test("rejects letter-digit patterns that are not real FSAs", () => {
    // Canada issues no FSA beginning with W or Z.
    assert.equal(parsePostalCode("W1A 1AA"), null);
    assert.equal(parsePostalCode("Unit 4B2 Main St"), null);
  });
});

describe("resolveLocation — coordinates", () => {
  test("passes through an explicit lat/lon object", () => {
    const r = resolveLocation({ lat: 43.65, lon: -79.38 }, THEATRES);
    assert.equal(r.found, true);
    assert.equal(r.source, "coordinates");
    assert.ok(km(r, TORONTO) < 5);
  });

  test("parses a coordinate string", () => {
    const r = resolveLocation("49.2827, -123.1207", THEATRES);
    assert.equal(r.precision, "exact");
    assert.ok(km(r, VANCOUVER) < 1);
  });
});

/**
 * Postal codes are the reason this module exists. Measured on 2026-07-31,
 * Claude's own recall put 12 of 16 sampled FSAs within 10 km but placed T9K in
 * Cold Lake when it is Fort McMurray — 264 km off, asserted exactly as firmly
 * as the correct answers. These must come from the table, every time.
 */
describe("resolveLocation — postal codes", () => {
  test("resolves a downtown Toronto postal code", () => {
    const r = resolveLocation("M5B 2H1", THEATRES);
    assert.equal(r.source, "postal-code");
    assert.ok(km(r, TORONTO) < 15, `expected near Toronto, got ${r.lat},${r.lon}`);
  });

  test("resolves postal codes that open geocoders get wrong", () => {
    // Nominatim returned no match for T2P and placed V6B ~400 km off.
    const calgary = resolveLocation("T2P 2M5", THEATRES);
    assert.ok(km(calgary, CALGARY) < 60, `T2P landed at ${calgary.lat},${calgary.lon}`);

    const vancouver = resolveLocation("V6B 1A1", THEATRES);
    assert.ok(km(vancouver, VANCOUVER) < 15, `V6B landed at ${vancouver.lat},${vancouver.lon}`);
  });

  test("resolves the FSA a language model misattributes", () => {
    // T9K is Fort McMurray, not Cold Lake.
    const r = resolveLocation("T9K 0A1", THEATRES);
    assert.equal(r.found, true);
    assert.ok(
      km(r, { lat: 56.7264, lon: -111.381 }) < 40,
      `T9K should be Fort McMurray, got ${r.lat},${r.lon}`
    );
  });

  test("a bare FSA works, and works inside an address", () => {
    assert.equal(resolveLocation("M5B", THEATRES).source, "postal-code");
    const inAddress = resolveLocation("123 Front St W, Toronto, ON M5J 2M2", THEATRES);
    assert.equal(inAddress.source, "postal-code");
    assert.ok(km(inAddress, TORONTO) < 15);
  });

  test("urban FSAs are points; rural ones are labelled regions", () => {
    // Canada Post marks rural FSAs with a "0" in the second position, and they
    // can span hundreds of km — X0A covers the eastern Arctic.
    assert.equal(resolveLocation("M5B 2H1", THEATRES).precision, "fsa");
    assert.equal(resolveLocation("X0A 0H0", THEATRES).precision, "region");
  });

  test("postal codes resolve with no theatre directory available", () => {
    const r = resolveLocation("M5B 2H1", []);
    assert.equal(r.found, true);
    assert.equal(r.source, "postal-code");
  });
});

describe("resolveLocation — theatre names", () => {
  test("matches a short theatre name", () => {
    const r = resolveLocation("Yonge-Dundas", THEATRES);
    assert.equal(r.source, "theatre-name");
    assert.equal(r.label, "Cineplex Cinemas Yonge-Dundas and VIP");
    assert.equal(r.precision, "exact");
  });

  test("matches a fragment of the full name", () => {
    const r = resolveLocation("Scotiabank Theatre Vancouver", THEATRES);
    assert.equal(r.source, "theatre-name");
    assert.ok(km(r, VANCOUVER) < 5);
  });

  test("resolves a theatre whose name is not a city", () => {
    const r = resolveLocation("Courtney Park", THEATRES);
    assert.equal(r.source, "theatre-name");
    assert.ok(km(r, { lat: 43.6366, lon: -79.6902 }) < 1);
  });

  test("without a directory, theatre names do not resolve", () => {
    assert.equal(resolveLocation("Courtney Park", []).found, false);
  });
});

describe("resolveLocation — cities with a Cineplex theatre", () => {
  test("resolves from the live directory, not a bundled gazetteer", () => {
    const r = resolveLocation("Mississauga", THEATRES);
    assert.equal(r.source, "cineplex-city");
    assert.equal(r.label, "Mississauga, ON");
    assert.ok(km(r, { lat: 43.6366, lon: -79.6902 }) < 5);
  });

  test("a bare city name is the city, not a theatre named after it", () => {
    // "Scotiabank Theatre Vancouver" contains "vancouver", so a theatre-name
    // check running first would resolve the city to that one building.
    const r = resolveLocation("Vancouver", THEATRES);
    assert.equal(r.source, "cineplex-city");
    assert.equal(r.label, "Vancouver, BC");
  });

  test("averages a city's theatres rather than picking the first", () => {
    const twoInToronto = [
      ...THEATRES,
      theatre(7131, "Cineplex Queensway", "Queensway", "Toronto", "ON", 43.6236, -79.5327),
    ];
    const r = resolveLocation("Toronto", twoInToronto);
    assert.ok(Math.abs(r.lat - (43.6563 + 43.6236) / 2) < 0.001);
    assert.ok(Math.abs(r.lon - (-79.3807 + -79.5327) / 2) < 0.001);
  });

  test('"London" resolves to Ontario, where the theatre is', () => {
    const r = resolveLocation("London", THEATRES);
    assert.ok(km(r, { lat: 42.9849, lon: -81.2453 }) < 20, `got ${r.lat},${r.lon}`);
  });

  test("accepts a province code, a spelled-out province, and a trailing country", () => {
    for (const q of ["London, ON", "London Ontario", "London, ON, Canada"]) {
      const r = resolveLocation(q, THEATRES);
      assert.equal(r.found, true, `${q} should resolve`);
      assert.ok(km(r, { lat: 42.9849, lon: -81.2453 }) < 20);
    }
  });

  test("a city with no Cineplex theatre does not resolve", () => {
    // The caller is expected to supply coordinates for these; guessing from a
    // bundled gazetteer is what this module deliberately stopped doing.
    assert.equal(resolveLocation("Moose Jaw, SK", THEATRES).found, false);
    assert.equal(resolveLocation("Iqaluit", THEATRES).found, false);
  });
});

describe("resolveLocation — failures are reported, not guessed", () => {
  test("an unresolvable string returns found:false, pointing at lat/lon", () => {
    const r = resolveLocation("Kensington Market", THEATRES);
    assert.equal(r.found, false);
    assert.match(r.message, /lat/);
    assert.match(r.message, /postal code/i);
  });

  /**
   * Regression: an earlier version tried every suffix of an unmatched string
   * against a bundled place table, which sent "Yonge & Dundas" to the town of
   * Dundas near Hamilton (60 km off) and "Bloor and Bathurst" to Bathurst,
   * New Brunswick (~1000 km off). Nothing may resolve by partial word match.
   */
  test("a street name shared with a distant town never hijacks the result", () => {
    const r = resolveLocation("Bloor and Bathurst", THEATRES);
    assert.equal(r.found, false);
  });

  test("an intersection that names a theatre still resolves, via the theatre", () => {
    const r = resolveLocation("Yonge & Dundas", THEATRES);
    assert.equal(r.source, "theatre-name");
    assert.ok(km(r, TORONTO) < 5);
  });

  test("a foreign city is not mapped onto its Canadian namesake", () => {
    // "London, UK" must not become London, Ontario.
    assert.equal(resolveLocation("London, UK", THEATRES).found, false);
    assert.equal(resolveLocation("Chicago, IL", THEATRES).found, false);
  });

  test("empty input is reported clearly", () => {
    assert.equal(resolveLocation("", THEATRES).found, false);
    assert.equal(resolveLocation("   ", THEATRES).found, false);
    assert.equal(resolveLocation(undefined, THEATRES).found, false);
  });
});

describe("normalizePlace", () => {
  test("strips punctuation, case, and accents", () => {
    assert.equal(normalizePlace("St. John's"), "st john s");
    assert.equal(normalizePlace("MONTRÉAL"), "montreal");
    assert.equal(normalizePlace("  Niagara-on-the-Lake "), "niagara on the lake");
  });
});
