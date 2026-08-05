# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Toolshed" — a tiny self-hosted static site, served by nginx in a Docker container. It's a landing page (`index.html`) that links out to single-purpose tools, each living in its own subfolder. There is currently one tool, "Hardly Normal Staff", which is a phone-camera barcode scanner that opens the scanned product on the Harvey Norman website.

There is no build step, no package manager, and no test suite — this is hand-written HTML/CSS/vanilla JS, deployed as-is.

## Repo layout

The repo root **is** the deploy root: `index.html`, `assets/app.css`, and the `hardly-normal/` tool tree (`hardly-normal/index.html`, `hardly-normal/scan/index.html`) all live at top level, matching the `Dockerfile`'s `COPY assets ...` / `COPY hardly-normal ...` steps exactly. Keep it that way — a previous version of this repo had `app.css` sitting at the root and the `hardly-normal/` tree nested under an unrelated `mnt/user-data/outputs/site/` path (leftover from wherever the files were originally generated), which built fine locally but made every Coolify deploy fail with `"/assets": not found` / `"/hardly-normal": not found` since those paths genuinely didn't exist in the git tree. If you ever add a new top-level asset folder, it needs a matching `COPY` line in the `Dockerfile`.

**File permissions matter here.** nginx's worker processes run as an unprivileged user, so any file that isn't at least world-readable (`644` for files, `755` for dirs) 403s at runtime even though the Docker build itself succeeds silently. This has bitten this repo once already (files checked in as `600` from a restrictive local umask). If a fresh clone starts 403ing after `docker build` succeeds, check `ls -la` before anything else.

## Running / previewing

There's no dev server config checked in. Serve the repo root with any static file server, e.g. `python3 -m http.server` from the root, since pages use root-relative links (`/assets/app.css`, `/hardly-normal/`, `/hardly-normal/scan/`).

To build and run the container:
```
docker build -t hardly-normal .
docker run -p 8080:80 hardly-normal
```
Don't just check the build succeeds — actually `curl` the running container on `/`, `/hardly-normal/`, `/hardly-normal/scan/`, and `/assets/app.css` and confirm `200`s. A silent `403` (see permissions note above) or a wrong path only shows up at runtime, not at build time.

## Deployment

Coolify deploys `main` on every push via a GitHub webhook (`MrJaydos/Hardly-Normal`), building the `Dockerfile` directly — there's no CI step in between. That means a broken `Dockerfile` `COPY` path or a bad file permission only surfaces in the Coolify build log, not before the push. Given there's no build step to catch this earlier, verify a Docker build + a `curl` smoke test locally (per above) before pushing to `main`.

## Architecture notes

**Page pattern.** Every page is a single self-contained HTML file: inline `<script>`/`<style>` for page-specific behavior, plus a shared `app.css` for the common look (dark shell, `.tile` nav cards, `.rule` section marker, mono/sans font pairing via CSS custom properties in `:root`). New tools should follow the same shape — a landing tile added to `index.html`'s `.tiles` nav (there's a literal `<!-- Copy the block above to add a tool -->` comment marking where), and the tool's own pages reusing `/assets/app.css` rather than introducing new stylesheets.

**Routing.** There's no client-side router — nginx's `try_files $uri $uri/ =404` plus each tool being a real `<folder>/index.html` is what makes `/hardly-normal/` and `/hardly-normal/scan/` resolve. Links between pages use absolute root paths (`/`, `/hardly-normal/`, `/hardly-normal/scan/`), not relative paths.

**Caching (`nginx.conf`).** HTML responses are sent with `no-cache, must-revalidate` explicitly so pushed changes show up immediately; `/assets/` gets a 1-hour cache instead. Keep that split in mind if adding new static asset paths — they should live under `/assets/` to get cached, while any new `*.html` gets the no-cache treatment automatically via the existing regex location.

**The scanner (`hardly-normal/scan/index.html`).** Single-file app, no dependencies bundled:
- Decoding prefers the browser-native `BarcodeDetector` API and falls back to loading `@zxing/library` from a CDN at runtime only if it's unavailable — check `initDecoder()` before adding new formats (the `FORMATS` array is shared between both paths, but format *names* differ between the native API and ZXing's enum, see the two branches in `readFrame()`).
- Camera frames are cropped to a horizontal band (`cropFrame()`) before decoding, matching the `#reticle` guide overlay in the UI — scan accuracy tuning should adjust both together.
- The "open on Harvey Norman" link is built from a user-editable URL template (`store.tpl`, default in `DEFAULT_TPL`) stored in `localStorage` with a `{code}` placeholder, plus a scan history (`store.log`, capped at 60 entries) — both are per-device only, there's no backend.
- State machine is intentionally simple: `running` (camera loop via `requestAnimationFrame`/`setTimeout`) → `onScan()` locks the UI and shows the result sheet → `resume()`/"Keep scanning" returns to scanning. The loop is paused/stopped on `visibilitychange`/`pagehide` to release the camera.

## Conventions when adding a tool

- One folder per tool at the site root (`/<tool-slug>/`), with its own `index.html` as the tool's landing/menu page if it has multiple sub-pages (mirrors `hardly-normal/` → `hardly-normal/scan/`).
- Reuse `app.css`'s existing classes (`.shell`, `.tile`, `.rule`, `.back`, `.eyebrow`, `.foot`) rather than duplicating styles; only add page-specific CSS inline in a `<style>` block scoped to that page's own elements (see `scan/index.html` for the pattern).
- Keep pages dependency-free where possible; if a JS library is unavoidable, load it lazily from a CDN only when needed (as the ZXing fallback does), not as a blocking `<script src>` in `<head>`.
