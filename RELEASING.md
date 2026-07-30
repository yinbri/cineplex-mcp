# Releasing

This repo publishes **two things on two independent schedules**, and they
share one tag namespace. Getting them confused is the easiest way to break
the widget, so the scheme is written down here.

## The two release lines

| What | Tag format | Consumed by | Cadence |
|---|---|---|---|
| The MCP server | `v1.0.0` (semver, matches `package.json`) | People installing/updating the server | Whenever server code changes |
| The widget shell | `widget-v1`, `widget-v2`, … (monotonic integer) | **jsDelivr**, at runtime, by every rendered widget | Only when `src/seatMapTemplate.html` changes |

They are deliberately separate because they change for unrelated reasons: a
fix to seat scoring is a server release that must not disturb the widget, and
a CSS tweak in the widget is not a new version of the server.

Distinct prefixes mean the two lines can never collide. `v*` is the server;
`widget-v*` is the shell.

## The one rule that matters

**Never move, delete, or re-point a `widget-v*` tag.**

`src/seatMapTemplate.js` builds the widget's script URL from `SHELL_VERSION`:

```
https://cdn.jsdelivr.net/gh/yinbri/cineplex-mcp@widget-v1/dist/seatmap-shell.min.js
```

jsDelivr caches aggressively and does not revalidate. Measured 2026-07-30, the
shell URL comes back with:

```
cache-control: public, max-age=604800, s-maxage=43200
```

That's **7 days in the client** and 12 hours at jsDelivr's edge — and a branch
ref (`@master`) returns exactly the same headers, so pointing at a branch is no
safer. Move or re-point a tag and you get a slow, uneven rollout: some viewers
keep the old shell for up to a week, others pick up the new one, and nothing
reports which is which. A changed shell is always a **new tag**, never an
edited one.

This is also why `dist/seatmap-shell.min.js` is committed: jsDelivr serves
files straight out of the tagged commit, so the built artifact has to be in
git, not generated at install time.

## Releasing the server

1. Make sure the working tree is clean and `npm test` passes.
2. Bump `version` in `package.json`. Nothing else — `src/index.js` reads that
   value at startup and reports it in the MCP handshake, so there is no second
   place to update.
3. Commit, then tag and push:
   ```bash
   git tag v1.0.0
   git push origin master --tags
   ```
4. Sanity check: start the server and confirm the handshake reports the new
   version.
   ```bash
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' | node src/index.js
   ```

## Releasing a new widget shell

Only needed when `src/seatMapTemplate.html` changes.

1. Edit `src/seatMapTemplate.html` (the single source of truth — never edit
   `dist/` by hand).
2. Preview locally: `npm run preview`, or `npm run preview:cdn` to exercise
   the built shell rather than the inline template.
3. **Bump `SHELL_VERSION`** in `src/seatMapTemplate.js` — e.g. `widget-v1` →
   `widget-v2`.
4. Rebuild: `npm run build:shell`. This regenerates
   `dist/seatmap-shell.min.js` and `dist/shell-manifest.json`.
5. `npm test` — the shell tests confirm the committed build matches the
   template.
6. Commit both `dist/` files together with the template change, then tag and
   push:
   ```bash
   git tag widget-v2
   git push origin master --tags
   ```
7. Confirm the CDN can see it (jsDelivr fetches on first request; allow a
   moment):
   ```bash
   curl -sI https://cdn.jsdelivr.net/gh/yinbri/cineplex-mcp@widget-v2/dist/seatmap-shell.min.js | head -1
   ```

Steps 3 and 4 are order-sensitive on purpose: bump first, then build.

## What is enforced automatically

You do not have to remember all of the above — two guards catch the
mistakes that would otherwise be silent:

- **`npm run build:shell` refuses to overwrite the shell** when the content
  changed but `SHELL_VERSION` did not, because that combination means
  publishing new code under an already-cached tag. It exits non-zero with an
  explanation. `--force` overrides it for local experiments — never for a
  release.
- **`npm test` fails if `dist/` is out of date** with the template, or if
  `dist/shell-manifest.json` doesn't match. This is the one that catches
  "edited the template, forgot to rebuild" — a mistake that otherwise
  produces no error at all, just a widget quietly running old code. CI runs
  this on every push and pull request.

Neither guard can tell whether you actually pushed the tag, so step 6 is
still on you.
