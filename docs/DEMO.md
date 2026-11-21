# README demos and screenshots

English | [简体中文](DEMO.zh-CN.md)

The README GIFs and screenshots show the current renderer with synthetic traffic. The recording covers the overview, live application ranking, monthly application history, network quotas and dark mode.

## Regenerate the assets

Install the desktop dependencies with `npm ci --prefix apps/desktop`. The recorder also needs Python 3 with Pillow (`python -m pip install Pillow`). It uses Microsoft Edge on Windows and Playwright Chromium elsewhere. Install Chromium with `npm --prefix apps/desktop exec -- playwright install chromium` if needed.

From the repository root, run:

```sh
node tools/demo/capture.mjs
```

This updates `demo-zh-CN.gif`, `demo-en.gif`, `screenshot.png`, `screenshot-en.png`, `applications-zh-CN.png` and `applications-en.png` in [assets](assets/). Intermediate frames stay in ignored `del/demo/` for review. Set `WIFIMETER_BROWSER_CHANNEL=chromium` to use Chromium on Windows, or set `WIFIMETER_DEMO_PYTHON` to the Python executable that has Pillow installed.

## Data and recording

[fixture.mjs](../tools/demo/fixture.mjs) builds the sample from the existing test fixture, with a fixed date of November 21, 2026. Network names, application records, quotas and changing rates are synthetic. The renderer and Tauri bridge come from the application source; the transport supplies responses from memory. The recorder runs a headless browser with a fresh profile and restricts page requests to its local asset server. It does not start the native host or collector, open a user database, or read installed application icons.

Edit the sample in `fixture.mjs` and the recording steps in [capture.mjs](../tools/demo/capture.mjs) when updating the demo. Keep both languages on the same scenes and values.

## Review

Play both GIFs and inspect the still images. Check text readability, page changes, light and dark colors, and the end of the loop. Confirm that every feature shown exists in the current UI and that both languages use equivalent sample data.

```sh
npm run test:docs
npm run check:docs
```

The documentation tests cover the fixture's repeatability, date filtering and rejection of unsupported system operations. For changes to application behavior, use the checks in [Testing](TESTING.md).
