// Launch reference — what a local connector's launch command pins, read from
// its command + args alone. Informational: "can this configuration start a
// different version tomorrow without anyone editing it?". Not a detection,
// never a severity.
//
// Pure and runtime-free (no node:path), so it can run anywhere; the desktop
// computes it in the main process and sends the renderer only the result,
// never the raw args (which may carry secrets).
//
// Three launchers are understood — npx, uvx, docker run — because they fetch
// what they run by NAME at launch time. Anything else returns null: a local
// binary or script is whatever is on disk, and an http connector has no
// launch command at all.

import type { LaunchReference } from './types.js';

function baseName(command: string): string {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1] ?? command;
}

// A spec can be a URL (npx tarball or git URLs, uvx --from git+https://…), and
// a URL can carry user:token@. The result crosses to the renderer, so the
// userinfo is dropped from the raw spec before anything is read from it.
function withoutUserinfo(spec: string): string {
  return spec.replace(/(:\/\/)[^/@\s]*@/g, '$1');
}

// --- npx --------------------------------------------------------------------

// An exact semver version: 1.2.3, 1.2.3-beta.1, 1.2.3+build. No ranges, no
// tags, no partials (1.2 resolves to the newest 1.2.x).
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// npx flags that take a value. Every other flag (-y, --yes, --no, -q…) is a
// switch.
const NPX_VALUE_FLAGS: ReadonlySet<string> = new Set(['-p', '--package', '-c', '--call']);

/** Split an npm spec into name and version: `@scope/pkg@1.2.3` → name
 *  `@scope/pkg`, version `1.2.3`. The `@` of a scope is not a separator. */
function splitNpmSpec(spec: string): { name: string; version: string | undefined } {
  // A URL spec (tarball, git) has no registry version to read.
  if (spec.includes('://')) return { name: spec, version: undefined };
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: undefined };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function npxReference(args: readonly string[]): LaunchReference | null {
  let spec: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      spec ??= args[i + 1];
      break;
    }
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (NPX_VALUE_FLAGS.has(flag)) {
        const value = eq === -1 ? args[++i] : a.slice(eq + 1);
        // -p/--package names the package explicitly; the first one wins.
        if ((flag === '-p' || flag === '--package') && value !== undefined) spec ??= value;
      }
      continue;
    }
    spec ??= a;
    break;
  }
  if (spec === undefined || spec.length === 0) return null;
  spec = withoutUserinfo(spec);
  const { name, version } = splitNpmSpec(spec);
  const pinned = version !== undefined && EXACT_SEMVER.test(version);
  return pinned
    ? { launcher: 'npx', package: name, spec, mutable: false, pinned: version }
    : { launcher: 'npx', package: name, spec, mutable: true };
}

// --- uvx --------------------------------------------------------------------

// An exact PEP 440 release after `==` or `@`: 1.2.3, 2024.1, 1.0rc1,
// 1.0.post1. No wildcards (==1.*), no ranges.
const EXACT_PEP440 = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

// uvx options that take a value (uv 0.8 `uv tool run`). Every other option is
// a switch. --from is handled apart: it names the package.
const UVX_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--from', '--with', '--with-editable', '--with-requirements', '-w',
  '--python', '-p', '--index', '--index-url', '-i', '--extra-index-url',
  '--find-links', '-f', '--default-index', '--index-strategy', '--keyring-provider',
  '--resolution', '--prerelease', '--exclude-newer', '--link-mode',
  '--constraints', '-c', '--overrides', '--build-constraints', '-b',
  '--refresh-package', '--reinstall-package', '--upgrade-package', '-P',
  '--config-setting', '-C', '--python-preference', '--directory', '--project',
  '--config-file', '--cache-dir', '--color', '--env-file',
]);

/** `pkg[extra]==1.2.3` / `pkg@1.2.3` → name `pkg`, exact version if any. */
function splitPySpec(spec: string): { name: string; version: string | undefined } {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:(==|@)(.+))?$/.exec(spec);
  if (m === null) return { name: spec, version: undefined };
  const version = m[3] !== undefined && EXACT_PEP440.test(m[3]) ? m[3] : undefined;
  return { name: m[1]!, version };
}

function uvxReference(args: readonly string[]): LaunchReference | null {
  let from: string | undefined;
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      command = args[i + 1];
      break;
    }
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (UVX_VALUE_FLAGS.has(flag)) {
        const value = eq === -1 ? args[++i] : a.slice(eq + 1);
        if (flag === '--from' && value !== undefined) from ??= value;
      }
      continue;
    }
    command = a;
    break;
  }
  // With --from, the package is the --from spec and the positional is only
  // the command to run inside it.
  const raw = from ?? command;
  if (raw === undefined || raw.length === 0) return null;
  const spec = withoutUserinfo(raw);
  const { name, version } = splitPySpec(spec);
  return version !== undefined
    ? { launcher: 'uvx', package: name, spec, mutable: false, pinned: version }
    : { launcher: 'uvx', package: name, spec, mutable: true };
}

// --- docker run -------------------------------------------------------------

// docker's global options that take a value (before the subcommand).
const DOCKER_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--config', '-c', '--context', '-H', '--host', '-l', '--log-level',
  '--tlscacert', '--tlscert', '--tlskey',
]);

// `docker run` options that take a value. Short ones may be clustered with
// switches (-it, -dit) or carry their value attached (-p8080:80, -eFOO=bar).
const DOCKER_RUN_SHORT_VALUE: ReadonlySet<string> = new Set(['a', 'c', 'e', 'h', 'l', 'm', 'p', 'u', 'v', 'w']);
const DOCKER_RUN_LONG_VALUE: ReadonlySet<string> = new Set([
  '--add-host', '--annotation', '--attach', '--blkio-weight', '--blkio-weight-device',
  '--cap-add', '--cap-drop', '--cgroup-parent', '--cgroupns', '--cidfile',
  '--cpu-period', '--cpu-quota', '--cpu-rt-period', '--cpu-rt-runtime', '--cpu-shares',
  '--cpus', '--cpuset-cpus', '--cpuset-mems', '--detach-keys', '--device',
  '--device-cgroup-rule', '--device-read-bps', '--device-read-iops',
  '--device-write-bps', '--device-write-iops', '--dns', '--dns-option', '--dns-search',
  '--domainname', '--entrypoint', '--env', '--env-file', '--expose', '--gpus',
  '--group-add', '--health-cmd', '--health-interval', '--health-retries',
  '--health-start-interval', '--health-start-period', '--health-timeout', '--hostname',
  '--ip', '--ip6', '--ipc', '--isolation', '--kernel-memory', '--label', '--label-file',
  '--link', '--link-local-ip', '--log-driver', '--log-opt', '--mac-address', '--memory',
  '--memory-reservation', '--memory-swap', '--memory-swappiness', '--mount', '--name',
  '--net', '--network', '--network-alias', '--oom-score-adj', '--pid', '--pids-limit',
  '--platform', '--publish', '--pull', '--restart', '--runtime', '--security-opt',
  '--shm-size', '--stop-signal', '--stop-timeout', '--storage-opt', '--sysctl',
  '--tmpfs', '--ulimit', '--user', '--userns', '--uts', '--volume', '--volumes-from',
  '--workdir',
]);

const DIGEST = /@(sha256:[a-f0-9]{64})$/;

function dockerReference(args: readonly string[]): LaunchReference | null {
  // Skip global options, then require `run` or `container run`.
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    i += DOCKER_GLOBAL_VALUE_FLAGS.has(a) ? 2 : 1;
  }
  if (args[i] === 'container') i++;
  if (args[i] !== 'run') return null;
  i++;

  let image: string | undefined;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      image = args[i + 1];
      break;
    }
    if (a.startsWith('--')) {
      if (!a.includes('=') && DOCKER_RUN_LONG_VALUE.has(a)) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // A short cluster: the first value-taking letter owns the rest of the
      // cluster, or the next argument if it is the last letter.
      for (let k = 1; k < a.length; k++) {
        if (DOCKER_RUN_SHORT_VALUE.has(a[k]!)) {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    image = a;
    break;
  }
  if (image === undefined || image.length === 0) return null;
  const digest = DIGEST.exec(image);
  if (digest !== null) {
    return {
      launcher: 'docker',
      package: image.slice(0, digest.index),
      spec: image,
      mutable: false,
      // sha256: plus the first 12 hex, docker's own short form.
      pinned: digest[1]!.slice(0, 'sha256:'.length + 12),
    };
  }
  return { launcher: 'docker', package: image, spec: image, mutable: true };
}

/** The launch reference of a local connector, or null when its launcher is
 *  not one that resolves packages or images by name at launch time. */
export function launchReference(command: string, args: readonly string[]): LaunchReference | null {
  switch (baseName(command)) {
    case 'npx':
      return npxReference(args);
    case 'uvx':
      return uvxReference(args);
    case 'docker':
      return dockerReference(args);
    default:
      return null;
  }
}
