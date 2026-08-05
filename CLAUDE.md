# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Hardly Normal Tools" — a tiny self-hosted static site, served by nginx in a Docker container. It's a landing page (`index.html`) that links out to single-purpose tools, each living in its own subfolder **one level deep off the root** (`/scan/`, not `/hardly-normal/scan/`) — every tool should be reachable in a single click from the landing page. There is currently one tool: a phone-camera barcode scanner (`/scan/`) that opens the scanned product on the Harvey Norman website.

There is no build step, no package manager, and no test suite — this is hand-written HTML/CSS/vanilla JS, deployed as-is.

## Repo layout

The repo root **is** the deploy root: `index.html`, `assets/app.css`, and each tool's folder (currently just `scan/index.html`) all live at top level, matching the `Dockerfile`'s `COPY assets ...` / `COPY scan ...` steps exactly. Keep it that way — a previous version of this repo had `app.css` sitting at the root and the tool tree nested under an unrelated `mnt/user-data/outputs/site/` path (leftover from wherever the files were originally generated), which built fine locally but made every Coolify deploy fail with `"/assets": not found` / path-not-found errors since those paths genuinely didn't exist in the git tree. If you ever add a new top-level tool folder or asset folder, it needs a matching `COPY` line in the `Dockerfile`.

Tools also used to be nested one level deeper (`/hardly-normal/scan/`, behind an intermediate "Hardly Normal Staff" landing tile) — that middle hop was removed so every tool is one click from `/`. Don't reintroduce a grouping page between the root and a tool unless there's a real reason to.

**File permissions matter here.** nginx's worker processes run as an unprivileged user, so any file that isn't at least world-readable (`644` for files, `755` for dirs) 403s at runtime even though the Docker build itself succeeds silently. This has bitten this repo once already (files checked in as `600` from a restrictive local umask). If a fresh clone starts 403ing after `docker build` succeeds, check `ls -la` before anything else.

## Running / previewing

There's no dev server config checked in. Serve the repo root with any static file server, e.g. `python3 -m http.server` from the root, since pages use root-relative links (`/assets/app.css`, `/scan/`).

To build and run the container:
```
docker build -t hardly-normal .
docker run -p 8080:80 hardly-normal
```
Don't just check the build succeeds — actually `curl` the running container on `/`, `/scan/`, and `/assets/app.css` and confirm `200`s. A silent `403` (see permissions note above) or a wrong path only shows up at runtime, not at build time.

## Deployment

Coolify deploys `main` on every push via a GitHub webhook (`MrJaydos/Hardly-Normal`), building the `Dockerfile` directly — there's no CI step in between. That means a broken `Dockerfile` `COPY` path or a bad file permission only surfaces in the Coolify build log, not before the push. Given there's no build step to catch this earlier, verify a Docker build + a `curl` smoke test locally (per above) before pushing to `main`.

## Architecture notes

**Page pattern.** Every page is a single self-contained HTML file: inline `<script>`/`<style>` for page-specific behavior, plus a shared `app.css` for the common look (dark shell, `.tile` nav cards, `.rule` section marker, mono/sans font pairing via CSS custom properties in `:root`). New tools should follow the same shape — a landing tile added to `index.html`'s `.tiles` nav (there's a literal `<!-- Copy the block above to add a tool -->` comment marking where), and the tool's own pages reusing `/assets/app.css` rather than introducing new stylesheets.

**Routing.** There's no client-side router — nginx's `try_files $uri $uri/ =404` plus each tool being a real `<folder>/index.html` is what makes `/scan/` resolve. Links between pages use absolute root paths (`/`, `/scan/`), not relative paths.

**Caching (`nginx.conf`).** HTML responses are sent with `no-cache, must-revalidate` explicitly so pushed changes show up immediately; `/assets/` gets a 1-hour cache instead. Keep that split in mind if adding new static asset paths — they should live under `/assets/` to get cached, while any new `*.html` gets the no-cache treatment automatically via the existing regex location.

**The scanner (`scan/index.html`).** Single-file app, no dependencies bundled:
- Decoding prefers the browser-native `BarcodeDetector` API and falls back to loading `@zxing/library` from a CDN at runtime only if it's unavailable — check `initDecoder()` before adding new formats (the `FORMATS` array is shared between both paths, but format *names* differ between the native API and ZXing's enum, see the two branches in `readFrame()`).
- **The ZXing fallback path decodes a cropped canvas by constructing `new ZXing.HTMLCanvasElementLuminanceSource(c)` → `BinaryBitmap`/`HybridBinarizer` → `zxing.decodeBitmap(binaryBitmap)` by hand — it does not call `decode()` or `decodeFromCanvas()`.** Both of the more obvious-looking APIs are broken for this use case on `@zxing/library@0.21.3`: `decodeFromCanvas` doesn't exist on `BrowserCodeReader` at all (throws immediately), and `decode(element)`'s internal `createBinaryBitmap()` reads `element.naturalWidth`/`naturalHeight` — `<img>`-only properties that are `undefined` on a canvas — then draws into ZXing's own cached, never-resized internal capture canvas, which throws a mis-sized-buffer index error on every attempt. Both failures previously broke scanning silently on any browser without native `BarcodeDetector` (all of iOS Safari — Chrome/Android has the native API and was unaffected either way) with no visible signal anything was wrong: camera live, loop running, state said "scanning", exception swallowed by the surrounding `catch`. If you touch `readFrame()`'s ZXing branch again, verify against the actual pinned version's source (`unpkg.com/@zxing/library@0.21.3/esm/...`) rather than examples elsewhere — its public API has moved around across versions.
- There's a temporary `#dbg` on-screen readout (bottom-left, small mono text) showing which decoder loaded, camera resolution, frame-attempt count, and the last thrown error — added because this class of bug (loop alive, decode silently failing every frame) is invisible without either that or a cabled remote-debug session, and this is a phone-only tool. Safe to remove once scanning has been confirmed reliable across devices for a while; if you do, remove `#dbg`'s CSS, the `<div id="dbg">`, the `tries`/`lastErr`/`mode` bookkeeping in `loop()`/`readFrame()`, and the `setInterval` that renders it.
- Camera frames are cropped to a horizontal band (`cropFrame()`) before decoding, matching the `#reticle` guide overlay in the UI — scan accuracy tuning should adjust both together. Note `cropFrame()`'s height is a fraction of video *height* while the CSS reticle's height is a fraction of viewport *width* (`30vw` vs `vh*0.30`) — they're not necessarily proportional to each other across aspect ratios, so don't assume the visible guide box exactly bounds what's actually sampled.
- The "open on Harvey Norman" link is built from a user-editable URL template (`store.tpl`, default in `DEFAULT_TPL`) stored in `localStorage` with a `{code}` placeholder, plus a scan history (`store.log`, capped at 60 entries) — both are per-device only, there's no backend.
- State machine is intentionally simple: `running` (camera loop via `requestAnimationFrame`/`setTimeout`) → `onScan()` locks the UI and shows the result sheet → `resume()`/"Keep scanning" returns to scanning. The loop is paused/stopped on `visibilitychange`/`pagehide` to release the camera.

## PWA / homescreen install

- `assets/manifest.webmanifest` + `assets/icons/*` (generated PNGs, dark navy background with the cyan "HN" mono glyph matching the site's tile style) make the site installable. `nginx.conf` has an explicit `location` for the manifest since nginx's default `mime.types` doesn't know the `.webmanifest` extension — without it, some browsers reject the manifest based on content type.
- `sw.js` (repo root, so its scope covers both `/` and `/scan/`) is intentionally **network-first for page navigations** and cache-first only for static assets. This matters because `nginx.conf`'s whole design intent is "never show a stale page on a phone" (see its own comments) — a service worker cache is much stickier client-side than an HTTP cache, so it only falls back to the cached page when the network genuinely fails, never preferring stale HTML while online.
- **No `apple-mobile-web-app-capable` meta tag, deliberately.** iOS's standalone (homescreen) mode has a long-standing, still-open WebKit bug ([#215884](https://bugs.webkit.org/show_bug.cgi?id=215884)) where camera permission gets re-prompted on navigation — bad enough that commercial barcode-scanning SDK vendors document it as a known iOS PWA issue. Since this site's only tool is camera-dependent, staying in a normal Safari tab (reliable per-origin permission storage) matters more than a chromeless window. The manifest itself still has `display: "standalone"` for Android/Chrome, which isn't affected by this bug. Don't add the Apple meta tag back without re-checking whether that WebKit bug is actually fixed.
- Both pages register the service worker and link the manifest/icons independently (no shared partial exists in this codebase — see "Page pattern" below) — if you add a third page, it needs the same `<link>`/`<meta>` block and registration script too.

## Conventions when adding a tool

- One folder per tool at the site root (`/<tool-slug>/`), one click from `index.html` — no intermediate grouping/landing pages (see the layout note above).
- Reuse `app.css`'s existing classes (`.shell`, `.tile`, `.rule`, `.back`, `.eyebrow`, `.foot`) rather than duplicating styles; only add page-specific CSS inline in a `<style>` block scoped to that page's own elements (see `scan/index.html` for the pattern).
- Keep pages dependency-free where possible; if a JS library is unavoidable, load it lazily from a CDN only when needed (as the ZXing fallback does), not as a blocking `<script src>` in `<head>`.
