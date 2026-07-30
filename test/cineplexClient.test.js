import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SimpleCache,
  isRetryableStatus,
  retryDelayMs,
  getTheatres,
  CineplexApiError,
  resolveSubscriptionKey,
  extractChunkUrls,
  extractSubscriptionKey,
  _resetKeyDiscovery,
} from "../src/cineplexClient.js";

describe("SimpleCache", () => {
  test("stores and returns a value, and expires it after its TTL", async () => {
    const cache = new SimpleCache();
    cache.set("k", "v", 20);
    assert.equal(cache.get("k"), "v");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cache.get("k"), undefined, "entry should be gone once its TTL passes");
  });

  test("a null TTL means process-lifetime (never expires on its own)", () => {
    const cache = new SimpleCache();
    cache.set("k", "v");
    assert.equal(cache.get("k"), "v");
  });

  test("evicts oldest-first once over the entry cap", () => {
    const cache = new SimpleCache(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // pushes over the cap of 3

    assert.equal(cache.size, 3, "cache should stay at its cap");
    assert.equal(cache.get("a"), undefined, "oldest entry should have been evicted");
    assert.equal(cache.get("d"), 4, "newest entry should survive");
  });

  test("re-setting a key makes it newest, so a hot key isn't evicted as 'old'", () => {
    const cache = new SimpleCache(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("a", 99); // 'a' is refreshed — 'b' is now the oldest
    cache.set("d", 4);

    assert.equal(cache.get("a"), 99, "refreshed key should survive eviction");
    assert.equal(cache.get("b"), undefined, "oldest key after the refresh should be evicted");
  });

  test("eviction sweeps expired entries even if they are never looked up again", () => {
    const cache = new SimpleCache(2);
    // Already-expired entries: get() would clear these, but nothing ever calls
    // get() for them. Only the sweep inside evict() can reclaim them, which is
    // the whole reason eviction exists on top of TTLs.
    cache.set("stale1", 1, -1);
    cache.set("stale2", 2, -1);
    assert.equal(cache.size, 2);

    cache.set("fresh", 3); // trips eviction

    assert.equal(cache.size, 1, "both expired entries should have been swept");
    assert.equal(cache.get("fresh"), 3);
  });
});

describe("isRetryableStatus", () => {
  test("retries transient failures", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
    }
  });

  test("does not retry failures that will repeat identically", () => {
    // 401 = rotated subscription key, 404 = bad ID. Retrying only burns time.
    for (const status of [200, 301, 400, 401, 403, 404]) {
      assert.equal(isRetryableStatus(status), false, `${status} should not be retryable`);
    }
  });
});

describe("retryDelayMs", () => {
  const withRetryAfter = (value) => ({ headers: { get: () => value } });

  test("falls back to exponential backoff when no Retry-After is sent", () => {
    const res = withRetryAfter(null);
    assert.equal(retryDelayMs(res, 1), 500);
    assert.equal(retryDelayMs(res, 2), 1000);
    assert.equal(retryDelayMs(res, 3), 2000);
  });

  test("honours Retry-After given in seconds", () => {
    assert.equal(retryDelayMs(withRetryAfter("2"), 1), 2000);
  });

  test("honours Retry-After given as an HTTP date", () => {
    const res = withRetryAfter(new Date(Date.now() + 2000).toUTCString());
    const delay = retryDelayMs(res, 1);
    assert.ok(delay > 1000 && delay <= 2000, `expected ~2000ms, got ${delay}`);
  });

  test("caps an excessive Retry-After so a tool call can't stall for minutes", () => {
    assert.equal(retryDelayMs(withRetryAfter("600"), 1), 5000);
  });

  test("ignores an unparseable Retry-After and backs off instead", () => {
    assert.equal(retryDelayMs(withRetryAfter("soon"), 1), 500);
  });

  test("never returns a negative delay for a Retry-After date in the past", () => {
    const res = withRetryAfter(new Date(Date.now() - 60_000).toUTCString());
    assert.equal(retryDelayMs(res, 1), 0);
  });
});

describe("cineplexFetch retry behaviour (via getTheatres)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Minimal Response stand-in; only what cineplexFetch actually touches. */
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
  });

  test("retries a transient 503 and succeeds on the next attempt", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? response(503) : response(200, [{ theatreId: 1, theatreName: "Test" }]);
    };

    // Unique coordinates per test — the module-level cache is keyed by
    // lat/lon/range/date, so reusing them across tests would hit the cache
    // instead of the patched fetch.
    const theatres = await getTheatres({ lat: 1.001, lon: -1.001, rangeKm: 5 });

    assert.equal(calls, 2, "should have retried exactly once");
    assert.equal(theatres[0].theatreName, "Test");
  });

  test("does not retry a 404, and surfaces it as a CineplexApiError", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response(404);
    };

    await assert.rejects(
      () => getTheatres({ lat: 2.002, lon: -2.002, rangeKm: 5 }),
      CineplexApiError
    );
    assert.equal(calls, 1, "a 404 will repeat identically — it should not be retried");
  });

  test("gives up after the attempt cap and reports the failure", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response(500);
    };

    await assert.rejects(
      () => getTheatres({ lat: 3.003, lon: -3.003, rangeKm: 5 }),
      (err) => err instanceof CineplexApiError && /500/.test(err.message)
    );
    assert.equal(calls, 3, "1 initial attempt + 2 retries");
  });

  test("retries a network-level failure, not just HTTP errors", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return response(200, []);
    };

    const theatres = await getTheatres({ lat: 4.004, lon: -4.004, rangeKm: 5 });

    assert.equal(calls, 2, "a dropped socket should be retried");
    assert.deepEqual(theatres, []);
  });
});

describe("resolveSubscriptionKey", () => {
  const isKeyShaped = (k) => /^[0-9a-f]{32}$/.test(k);

  test("falls back to the bundled key when nothing overrides it", () => {
    assert.ok(isKeyShaped(resolveSubscriptionKey({})), "bundled key should be a 32-char hex string");
  });

  test("an env override wins", () => {
    assert.equal(resolveSubscriptionKey({ CINEPLEX_SUBSCRIPTION_KEY: "override-me" }), "override-me");
  });

  test("a set-but-empty env var falls back instead of sending an empty key", () => {
    // `CINEPLEX_SUBSCRIPTION_KEY=` is a common config slip; treating it as an
    // override would produce a 401 indistinguishable from a real rotation.
    assert.ok(isKeyShaped(resolveSubscriptionKey({ CINEPLEX_SUBSCRIPTION_KEY: "" })));
    assert.ok(isKeyShaped(resolveSubscriptionKey({ CINEPLEX_SUBSCRIPTION_KEY: "   " })));
  });

  test("trims surrounding whitespace from an override", () => {
    assert.equal(resolveSubscriptionKey({ CINEPLEX_SUBSCRIPTION_KEY: "  abc123  " }), "abc123");
  });
});

describe("extractChunkUrls", () => {
  test("pulls chunk URLs out of homepage HTML, absolute or relative, deduped", () => {
    const html = `
      <script src="https://www.cineplex.com/next-static-files/_next/static/chunks/main-abc.js"></script>
      <script src="/next-static-files/_next/static/chunks/9026-def.js"></script>
      <script src="https://www.cineplex.com/next-static-files/_next/static/chunks/main-abc.js"></script>
      <link href="/styles/site.css">
    `;
    const urls = extractChunkUrls(html);

    assert.equal(urls.length, 2, "duplicates should collapse and non-JS should be ignored");
    assert.ok(urls.every((u) => u.startsWith("https://www.cineplex.com/")), "relative refs should resolve absolute");
    assert.ok(urls.some((u) => u.endsWith("9026-def.js")));
  });

  test("returns nothing for HTML with no chunk references", () => {
    assert.deepEqual(extractChunkUrls("<html><body>no scripts here</body></html>"), []);
  });
});

describe("extractSubscriptionKey", () => {
  // Shapes taken from cineplex.com's real minified bundle (2026-07-30).
  const DECOY = `r.d(t,{k:function(){return o}});let i={headers:{"Ocp-Apim-Subscription-Key":"477f072109904a55927ba2c3bf9f77e3"}},o=async()=>(0,n.U2)("https://apis.cineplex.com/prod/api/v1/target/personalized-smart-banner",i)`;
  const THEATRICAL = `let l="https://apis.cineplex.com/prod/cpx/theatrical/api",c={credentials:"include",headers:{"Ocp-Apim-Subscription-Key":"dcdac5601d864addbc2675a2e96cb1f8",CCToken:a.env.NEXT_PUBLIC_CONNECT_SESSION_TOKEN}}`;

  test("picks the theatrical key, not another API's key that appears first", () => {
    // This is the whole reason the extractor anchors on the theatrical URL
    // rather than the header name: the bundle ships several keys, and the
    // marketing one appears earlier. Matching the header name alone would
    // return the decoy, which 401s forever and mimics a broken rotation.
    const key = extractSubscriptionKey(`${DECOY};${THEATRICAL}`);
    assert.equal(key, "dcdac5601d864addbc2675a2e96cb1f8");
  });

  test("finds the key when it precedes the theatrical URL", () => {
    const inverted = `c={headers:{"Ocp-Apim-Subscription-Key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},l="https://apis.cineplex.com/prod/cpx/theatrical/api"`;
    assert.equal(extractSubscriptionKey(inverted), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("returns null for a chunk with no theatrical reference", () => {
    assert.equal(extractSubscriptionKey(DECOY), null, "a decoy-only chunk must not yield a key");
    assert.equal(extractSubscriptionKey("console.log('unrelated chunk')"), null);
  });

  test("returns null when the theatrical URL appears with no key nearby", () => {
    const far = `"https://apis.cineplex.com/prod/cpx/theatrical/api"${" ".repeat(900)}"Ocp-Apim-Subscription-Key":"dcdac5601d864addbc2675a2e96cb1f8"`;
    assert.equal(extractSubscriptionKey(far), null);
  });
});

describe("automatic key re-capture after a rotation", () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.CINEPLEX_SUBSCRIPTION_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.CINEPLEX_SUBSCRIPTION_KEY;
    else process.env.CINEPLEX_SUBSCRIPTION_KEY = realEnv;
    _resetKeyDiscovery();
  });

  const NEW_KEY = "ffffffffffffffffffffffffffffffff";
  const HOMEPAGE = `<script src="https://www.cineplex.com/next-static-files/_next/static/chunks/9026-x.js"></script>`;
  const CHUNK = `let l="https://apis.cineplex.com/prod/cpx/theatrical/api",c={headers:{"Ocp-Apim-Subscription-Key":"${NEW_KEY}"}}`;

  const textResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => body,
  });

  test("rediscovers the key on a 401 and retries the request with it", async () => {
    delete process.env.CINEPLEX_SUBSCRIPTION_KEY;
    _resetKeyDiscovery();

    const sentKeys = [];
    globalThis.fetch = async (url, init) => {
      if (url === "https://www.cineplex.com/") return textResponse(HOMEPAGE);
      if (url.endsWith("9026-x.js")) return textResponse(CHUNK);

      const key = init.headers["Ocp-Apim-Subscription-Key"];
      sentKeys.push(key);
      if (key !== NEW_KEY) {
        return { ok: false, status: 401, statusText: "Unauthorized", headers: { get: () => null } };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => [{ theatreId: 42, theatreName: "Rediscovered" }],
      };
    };

    const theatres = await getTheatres({ lat: 5.005, lon: -5.005, rangeKm: 5 });

    assert.equal(theatres[0].theatreName, "Rediscovered");
    assert.equal(sentKeys.length, 2, "one rejected attempt, then one with the new key");
    assert.notEqual(sentKeys[0], NEW_KEY, "first attempt uses the old key");
    assert.equal(sentKeys[1], NEW_KEY, "retry uses the rediscovered key");
  });

  test("an env override is never silently replaced by discovery", async () => {
    process.env.CINEPLEX_SUBSCRIPTION_KEY = "operator-supplied";
    _resetKeyDiscovery();

    let discoveryCalls = 0;
    globalThis.fetch = async (url) => {
      if (url === "https://www.cineplex.com/") discoveryCalls++;
      return { ok: false, status: 401, statusText: "Unauthorized", headers: { get: () => null } };
    };

    await assert.rejects(
      () => getTheatres({ lat: 6.006, lon: -6.006, rangeKm: 5 }),
      (err) => err instanceof CineplexApiError && /CINEPLEX_SUBSCRIPTION_KEY/.test(err.message)
    );
    assert.equal(discoveryCalls, 0, "an explicit override must be respected, not overridden");
  });

  test("reports a clear, actionable error when discovery finds nothing", async () => {
    delete process.env.CINEPLEX_SUBSCRIPTION_KEY;
    _resetKeyDiscovery();

    globalThis.fetch = async (url) => {
      if (url === "https://www.cineplex.com/") return textResponse("<html>no chunks</html>");
      return { ok: false, status: 401, statusText: "Unauthorized", headers: { get: () => null } };
    };

    await assert.rejects(
      () => getTheatres({ lat: 7.007, lon: -7.007, rangeKm: 5 }),
      (err) =>
        err instanceof CineplexApiError &&
        /most likely rotated/.test(err.message) &&
        /CAPTURE\.md/.test(err.message)
    );
  });

  test("does not attempt discovery for non-theatrical 401s", async () => {
    delete process.env.CINEPLEX_SUBSCRIPTION_KEY;
    _resetKeyDiscovery();

    let discoveryCalls = 0;
    globalThis.fetch = async (url) => {
      if (url === "https://www.cineplex.com/") discoveryCalls++;
      return { ok: false, status: 401, statusText: "Unauthorized", headers: { get: () => null } };
    };

    // Seat endpoints need no key at all, so a 401 there means something else.
    const { getRawSeatMap } = await import("../src/cineplexClient.js");
    await assert.rejects(() => getRawSeatMap({ theatreId: 1, showtimeId: 2 }), CineplexApiError);
    assert.equal(discoveryCalls, 0, "ticketing 401s are unrelated to the subscription key");
  });
});
