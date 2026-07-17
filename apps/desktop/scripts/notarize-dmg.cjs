// afterAllArtifactBuild hook (wired in electron-builder.yml): notarize and
// staple the DMG, closing the gap where `package:mac` produced a notarized
// .app inside an un-notarized DMG that then needed a manual
// `notarytool submit` + `stapler staple`.
//
// Anti-silence contract: this hook either completes the DMG (submit → wait →
// Accepted → staple → validate) or THROWS, which aborts the whole build with
// exit != 0 (verified on electron-builder 25.1.8: the hook is awaited in
// build()'s promise chain, executeFinally re-throws, and the CLI maps the
// rejection to process.exitCode = 1). The one legitimate skip is the explicit
// XCG_SKIP_DMG_NOTARIZE=1 opt-out for local dev builds, which prints an
// unmissable warning. A missing keychain profile is a hard error — never the
// .app's silent "signed but not notarized" failure mode (17/07).
//
// NOTE on blockmaps: stapling MODIFIES the DMG after electron-builder computed
// <dmg>.blockmap, so the blockmap no longer matches the shipped file. Harmless
// today (no `publish` config, no electron-updater); revisit if auto-update
// ever lands.

'use strict';

const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const SKIP_ENV = 'XCG_SKIP_DMG_NOTARIZE';
const PROFILE_ENV = 'APPLE_KEYCHAIN_PROFILE';

function log(message) {
  console.log(`  • notarize-dmg  ${message}`);
}

// Builds the command runner over an injectable execFileSync. The injection
// exists for tests ONLY: vitest cannot intercept node builtins required from
// an externalized .cjs (vi.mock never sees this file's require), so the tests
// pass a fake exec as the hook's second argument. electron-builder invokes
// the hook with a single argument → production always uses the real one.
// On failure, re-throws with captured stdout+stderr appended so the build
// log shows WHY (notarytool's detail lands on stdout even for failures).
function makeRun(execFileSync) {
  return function run(cmd, args) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n');
      throw new Error(`${cmd} ${args.join(' ')} failed:\n${detail || err.message}`);
    }
  };
}

// The signed .app lives in <outDir>/mac*/<product>.app (mac-arm64 today; kept
// arch-agnostic on purpose).
function findApp(outDir) {
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue;
    const dir = path.join(outDir, entry.name);
    for (const inner of readdirSync(dir)) {
      if (inner.endsWith('.app')) return path.join(dir, inner);
    }
  }
  return null;
}

module.exports.default = async function notarizeDmg(buildResult, execFileSync = defaultExecFileSync) {
  const run = makeRun(execFileSync);
  if (process.env[SKIP_ENV] === '1') {
    console.warn(
      [
        '',
        '  ╳╳╳ notarize-dmg SKIPPED (XCG_SKIP_DMG_NOTARIZE=1) ╳╳╳',
        '  ╳╳╳ The DMG is NOT notarized and NOT stapled.       ╳╳╳',
        '  ╳╳╳ This artifact is NOT distributable.              ╳╳╳',
        '',
      ].join('\n'),
    );
    return [];
  }

  const profile = process.env[PROFILE_ENV];
  if (profile === undefined || profile === '') {
    throw new Error(
      `notarize-dmg: ${PROFILE_ENV} is not set, so the DMG cannot be notarized. ` +
        `Export ${PROFILE_ENV}=<notarytool keychain profile> (e.g. xclaude-notary) ` +
        `before running package:mac, or set ${SKIP_ENV}=1 for a local, ` +
        `NON-distributable dev build. Refusing to produce a silently ` +
        `un-notarized DMG.`,
    );
  }

  const dmgs = buildResult.artifactPaths.filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    throw new Error(
      'notarize-dmg: no .dmg among the built artifacts — the hook expects the ' +
        'DMG target. If the target list changed on purpose, update or remove ' +
        'this hook (electron-builder.yml, afterAllArtifactBuild).',
    );
  }

  // (d) The integrated .app notarization silently skips when it finds no
  // credentials (observed 17/07). A stapled .app is the proof it ran; refuse
  // to notarize a DMG wrapping an un-notarized .app.
  const appPath = findApp(buildResult.outDir);
  if (appPath === null) {
    throw new Error(`notarize-dmg: no .app found under ${buildResult.outDir}/mac*`);
  }
  log(`validating .app staple: ${appPath}`);
  try {
    run('xcrun', ['stapler', 'validate', appPath]);
  } catch (err) {
    throw new Error(
      `notarize-dmg: the .app inside the DMG is not stapled — electron-builder's ` +
        `integrated notarization did not run (it skips SILENTLY when it finds no ` +
        `credentials). Run the build with ${PROFILE_ENV} exported so both the ` +
        `.app and the DMG notarize.\n${err.message}`,
    );
  }
  log('.app staple OK');

  for (const dmg of dmgs) {
    log(`submitting to Apple notary service (--wait): ${path.basename(dmg)}`);
    const out = run('xcrun', [
      'notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait',
    ]);
    if (!/status:\s*Accepted/.test(out)) {
      throw new Error(`notarize-dmg: notarization did not end in Accepted:\n${out}`);
    }
    log('notarization Accepted');

    log('stapling DMG');
    run('xcrun', ['stapler', 'staple', dmg]);
    run('xcrun', ['stapler', 'validate', dmg]);
    log(`stapled and validated: ${path.basename(dmg)}`);
  }

  return []; // no additional artifacts to publish
};
