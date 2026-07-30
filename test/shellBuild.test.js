import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildShell,
  checkVersionBump,
  shellHash,
  normalizeEol,
  readManifest,
  SHELL_PATH,
} from "../scripts/build-shell.mjs";
import { SHELL_VERSION } from "../src/seatMapTemplate.js";

/**
 * These guard the one failure mode this repo makes easy AND silent: the
 * committed dist/ shell is what jsDelivr serves to every widget, but nothing
 * about editing seatMapTemplate.html forces you to rebuild or re-tag it. A
 * stale shell produces no error anywhere — the widget just quietly renders
 * old code.
 */
describe("widget shell build", () => {
  test("the committed shell matches a fresh build of the template", () => {
    const committed = normalizeEol(readFileSync(SHELL_PATH, "utf8"));
    const rebuilt = normalizeEol(buildShell());

    assert.equal(
      committed,
      rebuilt,
      "dist/seatmap-shell.min.js is out of date with src/seatMapTemplate.html — run `npm run build:shell`"
    );
  });

  test("the manifest records the current shell version and hash", () => {
    const manifest = readManifest();
    assert.ok(manifest, "dist/shell-manifest.json is missing — run `npm run build:shell`");
    assert.equal(manifest.version, SHELL_VERSION, "manifest version is stale — run `npm run build:shell`");
    assert.equal(
      manifest.sha256,
      shellHash(readFileSync(SHELL_PATH, "utf8")),
      "manifest hash does not match the committed shell — run `npm run build:shell`"
    );
  });
});

describe("checkVersionBump", () => {
  const content = "shell contents";
  const matching = { version: SHELL_VERSION, sha256: shellHash(content) };

  test("allows the very first build, when no manifest exists yet", () => {
    assert.equal(checkVersionBump(content, null).ok, true);
  });

  test("allows a rebuild that changes nothing", () => {
    assert.equal(checkVersionBump(content, matching).ok, true);
  });

  test("allows changed content once SHELL_VERSION has been bumped", () => {
    const previous = { version: "widget-v0-old", sha256: shellHash("something else") };
    assert.equal(checkVersionBump(content, previous).ok, true);
  });

  test("blocks changed content under an unchanged SHELL_VERSION", () => {
    // The core rule: jsDelivr serves a tag with a 7-day cache and no
    // revalidation, so shipping new shell content under an already-published
    // version leaves widgets on the old shell for up to a week, silently.
    const stale = { version: SHELL_VERSION, sha256: shellHash("the previously published shell") };
    const result = checkVersionBump(content, stale);

    assert.equal(result.ok, false);
    assert.match(result.message, /SHELL_VERSION/);
    assert.match(result.message, /RELEASING\.md/);
  });
});
