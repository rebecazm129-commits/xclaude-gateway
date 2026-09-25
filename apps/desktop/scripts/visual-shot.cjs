// Electron side of the visual regression tool: loads harness scenarios and
// writes one raw bitmap plus one PNG per (scenario, width).
//
// Electron rather than Playwright on purpose. Playwright would add a
// dependency and download its own browsers to compare a UI that ships inside
// THIS Chromium — a mismatch in version, fonts or device pixel ratio would
// show up as a difference that no user will ever see. Capturing through the
// same Electron the product runs on removes that whole class of false alarm.
//
// Invoked by visual-regress.mjs, never directly.

const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const argv = process.argv.slice(process.defaultApp ? 2 : 1);
const outDir = argv[0];
const baseUrl = argv[1];
const scenarios = argv[2].split(',');
const widths = argv[3].split(',').map(Number);
const HEIGHT = 900;

// Animations and transitions would make two captures of the same DOM differ.
// Also hide the harness's own chrome so its scenario label never counts as a
// product change.
const FREEZE_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  .harnessBar { display: none !important; }
  .harnessFrame { height: 100vh !important; }
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** `scenario#Button label` captures the state AFTER clicking that button.
 *  Without it the tool can only ever see a view's initial state, which is how
 *  a change to a chip's pressed style came back as "zero pixels differ". */
async function capture(win, spec, width) {
  const [scenario, clickLabel] = spec.split('#');
  win.setContentSize(width, HEIGHT);
  await win.loadURL(`${baseUrl}/?scenario=${scenario}`);
  await win.webContents.insertCSS(FREEZE_CSS);
  if (clickLabel !== undefined && clickLabel !== '') {
    await wait(700);
    // Exact <button> label first, then any [role="button"] CONTAINING the
    // label — list rows are divs with that role, and they are what a capture
    // has to click to reach the detail panel.
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
         const want = ${JSON.stringify(clickLabel)};
         const exact = [...document.querySelectorAll('button')]
           .find((x) => x.textContent.trim() === want);
         // Then by aria-label, for the buttons that are an icon — Settings is
         // a gear, and its About text is public copy that has to be captured.
         const labelled = exact ?? document.querySelector('[aria-label="' + want + '"]');
         const target = labelled ?? [...document.querySelectorAll('[role="button"]')]
           .find((x) => (x.textContent ?? '').includes(want));
         if (target === undefined) return false; target.click(); return true; })()`,
    );
    if (!clicked) throw new Error(`no button labelled "${clickLabel}" in ${scenario}`);
  }
  // The views poll on an interval and measure their own height with a
  // ResizeObserver; give both a beat to settle before the shutter.
  await wait(900);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const stem = `${spec.replace(/[^A-Za-z0-9_.-]/g, '_')}@${width}`;
  // The raw bitmap is what gets compared — PNG encoding could in principle
  // differ for identical pixels. The PNG is for looking at.
  writeFileSync(join(outDir, `${stem}.bitmap`), image.toBitmap());
  writeFileSync(join(outDir, `${stem}.png`), image.toPNG());
  writeFileSync(
    join(outDir, `${stem}.json`),
    JSON.stringify({ width: size.width, height: size.height, scaleFactor: image.getScaleFactors?.()?.[0] ?? 1 }),
  );
  process.stdout.write(`  captured ${stem} (${size.width}x${size.height})\n`);
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: widths[0],
    height: HEIGHT,
    show: false,
    // Fixed scale factor: a capture taken on a Retina display and one taken on
    // an external monitor are not comparable.
    webPreferences: { zoomFactor: 1, backgroundThrottling: false },
  });
  try {
    for (const spec of scenarios) {
      for (const width of widths) {
        await capture(win, spec, width);
      }
    }
  } catch (err) {
    process.stderr.write(`capture failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    app.exit(1);
    return;
  }
  app.exit(0);
});
