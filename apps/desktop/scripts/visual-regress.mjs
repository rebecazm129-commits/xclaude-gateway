// Visual regression for the renderer, against the harness.
//
// The point is to make "no visible change" a MEASUREMENT instead of a claim.
// A refactor of Detections or Claude Code that says it changes nothing can say
// so with a pixel count behind it, and the reviewer's time goes to the designs
// that are actually new.
//
//   node scripts/visual-regress.mjs snap before
//   ...make the change...
//   node scripts/visual-regress.mjs snap after
//   node scripts/visual-regress.mjs diff
//
// Snapshots land in .visual/, which is gitignored: they are megabytes of
// machine-specific pixels, and a baseline committed from one display would
// fail on every other.
//
// REQUIRES the harness to be serving (pnpm harness). It is not started here on
// purpose — a script that starts and stops a dev server races with the one the
// developer already has open, and the two would disagree about which code is
// loaded.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(here);
const outRoot = join(appDir, '.visual');

const BASE_URL = process.env.XCG_HARNESS_URL ?? 'http://127.0.0.1:5199';
// A scenario may carry `#Button label`, which captures the state after that
// button is clicked — without it the tool only ever sees a view's initial
// state, which is how a change to a chip's PRESSED style came back as "zero
// pixels differ".
const SCENARIOS = (
  process.env.XCG_VISUAL_SCENARIOS ??
  [
    'detections-tab',
    'claude-code-tab',
    'claude-code-tab#Flagged only',
    'detections-scroll',
    // Panel OPEN, one per view. The drawer's stylesheet is shared by all
    // three, so a change to it is invisible to any capture that never opens
    // one — which is how a word-break fix reached the Detections panel
    // unmeasured.
    'detections-tab#stripe',
    'claude-code-tab#Bash',
    'needs-review#gmail',
    // The About paragraph states the category count, which is public copy.
    'detections-tab#Open settings',
    // The connector cards in Add source carry their own one-line copy, twelve
    // times over. Nothing else opens that modal.
    'baseline#+ Add source',
    // Real-trail shapes: normal activity as "None", every kind of source the
    // SOURCE column has to name, and the Flagged only chip in both states.
    'detections-activity',
    'detections-activity#Flagged only',
    'claude-code-activity',
    // The previous format is out of view by default; the Status filter, open
    // here, is the way in.
    'historical#Status (2/3) ▾',
    // Protocol tripwire, both shapes: the table, then the panel of the request
    // row (a server's sampling/createMessage) and of the response-side
    // enrichment (input_required, Tool column "[protocol]").
    'protocol-tripwire',
    'protocol-tripwire#sampling/createMessage',
    'protocol-tripwire#[protocol]',
    // Version source, one inspector per connector: npx without a version
    // (Mutable + note), npx pinned (Pinned to <version>), docker without a
    // digest (Mutable + tag note), and a remote (no row at all).
    'launch-reference#filesystem',
    'launch-reference#playwright',
    'launch-reference#github',
    'launch-reference#notion',
    // A catalog review line (review: baseline) in MCP changes, then its panel:
    // nothing moved, so no title, summary or disclaimer may say it changed.
    'baseline-review',
    'baseline-review#acme-docs',
    // MCP changes with the Needs review only chip lifted: nothing narrows the
    // list, so All changes is the card that reads as the filter.
    'needs-review#Needs review only',
    // audit_trail_modification: the table with both subtypes, then the panel
    // of the delete row (the only Bash row).
    'audit-trail',
    'audit-trail#Bash',
    // OAuth sign-ins in MCP changes: the list, each kind of row open, and the
    // Section filter naming the new section. Rows with no finding sit behind
    // the default "Needs review only" chip, so their captures turn it off first.
    'authorization#Needs review only',
    'authorization#Authorization server changed',
    'authorization#Permissions expanded',
    'authorization#Needs review only#First sign-in recorded',
    'authorization#Needs review only#Sign-in recorded (reference reset)',
    'authorization#Section (2/2) ▾',
    // Claude Code elicitation: the table (medium accepted, HIGH declined),
    // then the panel of the HIGH one.
    'elicitation',
    'elicitation#Sign in to Acme Cloud',
    // An install from before elicitation: the compact update card, then the
    // "Hooks updated" toast after the click.
    'hooks-outdated',
    'hooks-outdated#Update hooks',
    // Sources with the same install: the Claude Code inspector (backups row).
    'hooks-outdated-sources#claude-code',
    // settings.json is a symlink: the managed-externally notice instead.
    'settings-symlink',
    // Events not recorded at the spool cap: the persistent toast with Dismiss,
    // then the same toast over the update card.
    'spool-dropped',
    'hooks-outdated-dropped',
  ].join(',')
).split(',');
// Two widths: a narrow one where the 1fr column is squeezed and the chips wrap,
// and a wide one where they do not. Most layout regressions show at one but
// not the other.
const WIDTHS = (process.env.XCG_VISUAL_WIDTHS ?? '1100,1500').split(',');

function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

async function checkServer() {
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    fail(
      `The harness is not serving at ${BASE_URL} (${err instanceof Error ? err.message : String(err)}).\n` +
        `Start it first:  cd apps/desktop && pnpm harness`,
    );
  }
}

function snap(label) {
  const outDir = join(outRoot, label);
  mkdirSync(outDir, { recursive: true });
  const electron = join(appDir, 'node_modules', '.bin', 'electron');
  if (!existsSync(electron)) fail(`electron not found at ${electron}`);
  return new Promise((resolve) => {
    const child = spawn(
      electron,
      [join(here, 'visual-shot.cjs'), outDir, BASE_URL, SCENARIOS.join(','), WIDTHS.join(',')],
      { stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      if (code !== 0) fail(`capture failed (exit ${code})`);
      process.stdout.write(`\nsnapshot "${label}" written to ${outDir}\n`);
      resolve();
    });
  });
}

/**
 * Differing pixels between two BGRA buffers, and the box they fall in.
 *
 * The box is what makes a non-zero result readable: "1175 px in a 54x13 band
 * at the top" is a new tab label, while the same count spread over the whole
 * window is a layout shift. Without it every difference looks the same.
 */
function comparePixels(a, b, width) {
  if (a.length !== b.length) return { differing: -1, box: null };
  let differing = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      differing += 1;
      const p = i / 4;
      const x = p % width;
      const y = Math.floor(p / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const box = differing === 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { differing, box };
}

function diff() {
  const beforeDir = join(outRoot, 'before');
  const afterDir = join(outRoot, 'after');
  for (const d of [beforeDir, afterDir]) {
    if (!existsSync(d)) fail(`missing snapshot: ${d}\nRun:  node scripts/visual-regress.mjs snap ${d.endsWith('before') ? 'before' : 'after'}`);
  }
  const stems = readdirSync(beforeDir)
    .filter((f) => f.endsWith('.bitmap'))
    .map((f) => f.replace(/\.bitmap$/, ''))
    .sort();
  if (stems.length === 0) fail('the "before" snapshot has no captures');

  let worst = 0;
  const report = [];
  for (const stem of stems) {
    const afterBitmap = join(afterDir, `${stem}.bitmap`);
    if (!existsSync(afterBitmap)) {
      report.push(`  ${stem}: MISSING in "after"`);
      worst = Number.POSITIVE_INFINITY;
      continue;
    }
    const meta = JSON.parse(readFileSync(join(beforeDir, `${stem}.json`), 'utf8'));
    const a = readFileSync(join(beforeDir, `${stem}.bitmap`));
    const b = readFileSync(afterBitmap);
    const { differing, box } = comparePixels(a, b, meta.width);
    if (differing === -1) {
      report.push(`  ${stem}: SIZE CHANGED (${a.length} vs ${b.length} bytes)`);
      worst = Number.POSITIVE_INFINITY;
      continue;
    }
    const total = a.length / 4;
    const pct = ((differing / total) * 100).toFixed(4);
    worst = Math.max(worst, differing);
    report.push(
      differing === 0
        ? `  ${stem}: identical (${total} px)`
        : `  ${stem}: ${differing} px differ (${pct}%) in a ${box.w}x${box.h} box at ${box.x},${box.y}` +
          `\n      before: ${join(beforeDir, `${stem}.png`)}\n      after:  ${join(afterDir, `${stem}.png`)}`,
    );
  }

  // Captures the "after" has and the "before" does not are NEW COVERAGE, not
  // a pass. Saying so stops "8 captures, all identical" from reading as "the
  // panel was checked" the first time a panel capture is added.
  const afterStems = new Set(
    readdirSync(afterDir).filter((f) => f.endsWith('.bitmap')).map((f) => f.replace(/\.bitmap$/, '')),
  );
  const fresh = [...afterStems].filter((x) => !stems.includes(x)).sort();
  const freshNote =
    fresh.length === 0
      ? ''
      : `\n  new coverage, no baseline to compare against yet:\n    ${fresh.join('\n    ')}\n`;

  const summary = `\nvisual regression: ${stems.length} compared${fresh.length > 0 ? `, ${fresh.length} new` : ''}\n${report.join('\n')}\n${freshNote}`;
  process.stdout.write(summary);
  writeFileSync(join(outRoot, 'last-diff.txt'), summary);
  if (worst === 0) {
    process.stdout.write('\nNO VISIBLE CHANGE — zero differing pixels everywhere.\n\n');
    process.exit(0);
  }
  process.stdout.write('\nVISIBLE CHANGE — open the PNGs named above.\n\n');
  process.exit(1);
}

const [mode, label] = process.argv.slice(2);
if (mode === 'snap') {
  if (label !== 'before' && label !== 'after') fail('usage: visual-regress.mjs snap before|after');
  await checkServer();
  await snap(label);
} else if (mode === 'diff') {
  diff();
} else {
  fail('usage: visual-regress.mjs snap before|after   |   visual-regress.mjs diff');
}
