// audit_trail_modification: a Claude Code tool call that writes to or deletes
// from xCLAUDE's data folder. Every rule once, with the cases that must NOT
// fire next to the ones that must — the detector judges the operand an
// operation acts on, never the whole command.

import { describe, expect, it } from 'vitest';

import {
  bashOps,
  createAuditTrailModification,
  insideDataDir,
  resolvePath,
  splitSegments,
} from '../../src/detection/detectors/audit-trail-modification.js';
import type { DetectorInput } from '../../src/detection/types.js';

const HOME = '/Users/tester';
const DATA = `${HOME}/Library/Application Support/xCLAUDE Gateway`;
const Q = `"$HOME/Library/Application Support/xCLAUDE Gateway"`; // quoted, with $HOME
const E = '~/Library/Application\\ Support/xCLAUDE\\ Gateway'; // escaped spaces, with ~
const detect = createAuditTrailModification({ home: HOME });

function call(tool: string, args: Record<string, unknown>, opts: { cwd?: string; mcp?: string } = {}): DetectorInput {
  const payload = { name: tool, arguments: args };
  return {
    envelope: { payload, mcp: opts.mcp ?? 'claude-code', method: 'tools/call', direction: 'client_to_server', sessionId: 'S' },
    paramsJson: JSON.stringify(payload),
    toolName: tool,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
}
const bash = (command: string, cwd = '/Users/tester/code/app') => detect(call('Bash', { command }, { cwd }));
const ops = (command: string, cwd: string | null = '/Users/tester/code/app') =>
  bashOps(command, { home: HOME, dataDir: DATA, cwd }).map((o) => `${o.op}:${o.cmd}`);

describe('the finding', () => {
  it('category, severity, subtype and tool', () => {
    expect(bash(`rm ${Q}/wrappers/x.jsonl`)).toEqual({
      category: 'audit_trail_modification',
      severity: 'high',
      findings: [{ type: 'delete', location: 'Bash', rule: 'rm' }],
    });
    expect(detect(call('Write', { file_path: `${DATA}/manifests/v2/x.json`, content: '{}' }))).toEqual({
      category: 'audit_trail_modification',
      severity: 'high',
      findings: [{ type: 'write', location: 'Write' }],
    });
  });

  it('nothing for a clean call', () => {
    expect(bash('ls -la')).toBeNull();
  });
});

describe('Write, Edit, MultiEdit', () => {
  it('a file_path inside the folder is a write', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(detect(call(tool, { file_path: `${DATA}/audit-salt` }))?.findings, tool).toEqual([{ type: 'write', location: tool }]);
    }
  });

  it('outside the folder, or a sibling that only shares the prefix, is not', () => {
    expect(detect(call('Write', { file_path: `${HOME}/code/app/wrappers/x.jsonl` }))).toBeNull();
    expect(detect(call('Write', { file_path: `${DATA}-backup/x` }))).toBeNull();
  });

  it('Read is never judged (no reads in V1)', () => {
    expect(detect(call('Read', { file_path: `${DATA}/wrappers/x.jsonl` }))).toBeNull();
  });

  it('an MCP tool of the same name is out of scope', () => {
    expect(detect(call('Write', { file_path: `${DATA}/x` }, { mcp: 'filesystem' }))).toBeNull();
  });

  it('case does not hide it (macOS is case-insensitive)', () => {
    expect(detect(call('Edit', { file_path: `${HOME}/library/application support/xclaude gateway/x` }))).not.toBeNull();
  });
});

describe('Bash — executable normalisation', () => {
  it('/bin/rm, command rm, sudo rm, env VAR=1 rm, VAR=1 rm', () => {
    for (const c of [`/bin/rm ${Q}/x`, `command rm ${Q}/x`, `sudo rm -f ${Q}/x`, `sudo -u root rm ${Q}/x`, `env LC_ALL=C rm ${Q}/x`, `LC_ALL=C rm ${Q}/x`]) {
      expect(ops(c), c).toEqual(['delete:rm']);
    }
  });

  it('command -v rm is a lookup, not a run', () => {
    expect(ops(`command -v rm ${Q}/x`)).toEqual([]);
  });
});

describe('Bash — paths', () => {
  it('~, $HOME, ${HOME}, quotes and escaped spaces', () => {
    expect(ops(`rm ${E}/x`)).toEqual(['delete:rm']);
    expect(ops(`rm ${Q}/x`)).toEqual(['delete:rm']);
    expect(ops(`rm "\${HOME}/Library/Application Support/xCLAUDE Gateway/x"`)).toEqual(['delete:rm']);
    expect(ops(`rm '${DATA}/x'`)).toEqual(['delete:rm']);
  });

  it('a relative path resolves against the hook cwd', () => {
    expect(ops('rm wrappers/x.jsonl', DATA)).toEqual(['delete:rm']);
    expect(ops('rm wrappers/x.jsonl', `${HOME}/code/app`)).toEqual([]);
    expect(ops('rm ../xCLAUDE\\ Gateway/x', `${HOME}/Library/Application Support/Other`)).toEqual(['delete:rm']);
  });

  it('no cwd: a relative path cannot be judged', () => {
    expect(ops('rm wrappers/x.jsonl', null)).toEqual([]);
  });

  it('cd <literal> && … moves the cwd', () => {
    expect(ops(`cd ${Q} && rm wrappers/x.jsonl`)).toEqual(['delete:rm']);
    expect(ops(`cd ${E}/wrappers && rm -f *.jsonl`)).toEqual(['delete:rm']);
    // Only && chains the cd; after ; or | it is not followed.
    expect(ops(`cd ${Q} ; rm wrappers/x.jsonl`)).toEqual([]);
  });

  it('a variable that is not literal is not resolved (accepted false negative)', () => {
    expect(ops('rm "$D/x"')).toEqual([]);
  });

  it('a glob above the folder that matches it counts; a glob inside it counts', () => {
    expect(ops(`rm -rf ~/Library/Application\\ Support/*`)).toEqual(['delete:rm']);
    expect(ops(`rm ${E}/wrappers/*.jsonl`)).toEqual(['delete:rm']);
    expect(ops('rm -rf ~/Library/Caches/*')).toEqual([]);
  });

  it('insideDataDir and resolvePath directly', () => {
    expect(insideDataDir(DATA, DATA)).toBe(true);
    expect(insideDataDir(`${DATA}Other`, DATA)).toBe(false);
    expect(resolvePath('~', { home: HOME, dataDir: DATA, cwd: null })).toBe(HOME);
  });
});

describe('Bash — delete', () => {
  it('rm, rmdir, unlink, truncate, shred', () => {
    expect(ops(`rmdir ${Q}/locks`)).toEqual(['delete:rmdir']);
    expect(ops(`unlink ${Q}/audit-salt`)).toEqual(['delete:unlink']);
    expect(ops(`truncate -s 0 ${Q}/wrappers/x.jsonl`)).toEqual(['delete:truncate']);
    expect(ops(`shred -u ${Q}/wrappers/x.jsonl`)).toEqual(['delete:shred']);
  });

  it('find … -delete, by its starting path', () => {
    expect(ops(`find ${Q}/wrappers -name '*.jsonl' -mtime +7 -delete`)).toEqual(['delete:find']);
    expect(ops(`find ${Q}/wrappers -name '*.jsonl'`)).toEqual([]);
    expect(ops('find /tmp -name x -delete')).toEqual([]);
  });

  it('an rm of another file in the same command as an ls of the folder is NOT a delete of the folder', () => {
    expect(ops(`ls -la ${Q}/wrappers && rm -f /tmp/scratch.txt`)).toEqual([]);
    expect(ops(`du -sh ${Q}; rm -rf "$TMPDIR/xcg-test"`)).toEqual([]);
  });

  it('a find piped to xargs rm is not seen (accepted false negative)', () => {
    expect(ops(`find ${Q}/wrappers -name '*.jsonl' | xargs rm`)).toEqual([]);
  });
});

describe('Bash — write by destination', () => {
  it('cp, ditto, install INTO the folder are writes', () => {
    expect(ops(`cp /tmp/x.jsonl ${Q}/wrappers/`)).toEqual(['write:cp']);
    expect(ops(`ditto /tmp/app ${Q}/bin`)).toEqual(['write:ditto']);
    expect(ops(`install -m 600 /tmp/salt ${Q}/audit-salt`)).toEqual(['write:install']);
    expect(ops(`install -d ${Q}/new`)).toEqual(['write:install']);
    expect(ops(`cp -t ${Q}/wrappers /tmp/a /tmp/b`)).toEqual(['write:cp']);
  });

  it('cp and ditto FROM the folder to outside are NOT', () => {
    expect(ops(`cp ${Q}/wrappers/x.jsonl /tmp/`)).toEqual([]);
    expect(ops(`ditto ${Q} ~/backup/xcg`)).toEqual([]);
  });

  it('dd: only of=', () => {
    expect(ops(`dd if=/dev/zero of=${E}/audit-salt bs=32 count=1`)).toEqual(['write:dd']);
    expect(ops(`dd if=${E}/audit-salt of=/tmp/salt`)).toEqual([]);
  });

  it('ln: the link it creates', () => {
    expect(ops(`ln -s /tmp/evil ${Q}/bin/xcg-proxy`)).toEqual(['write:ln']);
    expect(ops(`ln -s ${Q}/bin/xcg-proxy /usr/local/bin/xcg-proxy`)).toEqual([]);
    expect(ops('ln -s /tmp/evil', DATA)).toEqual(['write:ln']); // one operand: created in the cwd
  });

  it('mv: source OR destination', () => {
    expect(ops(`mv ${Q}/wrappers/x.jsonl /tmp/`)).toEqual(['write:mv']);
    expect(ops(`mv /tmp/x.jsonl ${Q}/wrappers/`)).toEqual(['write:mv']);
    expect(ops('mv /tmp/a /tmp/b')).toEqual([]);
  });
});

describe('Bash — write by operand', () => {
  it('chmod, chown, chflags (the mode/owner is not a path)', () => {
    expect(ops(`chmod 644 ${Q}/audit-salt`)).toEqual(['write:chmod']);
    expect(ops(`chmod -R u+w ${Q}`)).toEqual(['write:chmod']);
    expect(ops(`chmod -w ${Q}/audit-salt`)).toEqual(['write:chmod']);
    expect(ops(`chown -R nobody:staff ${Q}`)).toEqual(['write:chown']);
    expect(ops(`chflags uchg ${Q}/wrappers/x.jsonl`)).toEqual(['write:chflags']);
    expect(ops('chmod 644 /tmp/x')).toEqual([]);
  });

  it('touch and tee', () => {
    expect(ops(`touch -t 202601010000 ${Q}/wrappers/x.jsonl`)).toEqual(['write:touch']);
    expect(ops(`echo x | tee -a ${Q}/wrappers/x.jsonl`)).toEqual(['write:tee']);
    expect(ops(`cat ${Q}/wrappers/x.jsonl | tee /tmp/copy`)).toEqual([]);
  });

  it('sed -i and perl -i, but not their read-only forms', () => {
    expect(ops(`sed -i '' 's/a/b/' ${Q}/wrappers/x.jsonl`)).toEqual(['write:sed']);
    expect(ops(`sed -i.bak -e 's/a/b/' ${Q}/wrappers/x.jsonl`)).toEqual(['write:sed']);
    expect(ops(`sed -n '1p' ${Q}/wrappers/x.jsonl`)).toEqual([]);
    expect(ops(`perl -pi -e 's/a/b/' ${Q}/wrappers/x.jsonl`)).toEqual(['write:perl']);
    expect(ops(`perl -ne 'print' ${Q}/wrappers/x.jsonl`)).toEqual([]);
  });

  it('> and >> into the folder; < and 2>&1 are not writes there', () => {
    expect(ops(`echo '{}' > ${Q}/wrappers/x.jsonl`)).toEqual(['write:>']);
    expect(ops(`echo '{}' >>${Q}/wrappers/x.jsonl`)).toEqual(['write:>>']);
    expect(ops(`printf x 2> ${Q}/err.log`)).toEqual(['write:2>']);
    expect(ops(`wc -l < ${Q}/wrappers/x.jsonl`)).toEqual([]);
    expect(ops(`cat ${Q}/wrappers/x.jsonl > /tmp/copy 2>&1`)).toEqual([]);
  });
});

describe('Bash — what the tokenizer must not misread', () => {
  it('a heredoc body is data, not commands', () => {
    const cmd = `python3 - <<'EOF'\nimport os\nos.system("rm ${DATA}/x")\nprint("> ${DATA}/y")\nEOF\necho done`;
    expect(ops(cmd)).toEqual([]);
  });

  it('a quoted > or ; is text', () => {
    expect(ops(`echo "> ${DATA}/x; rm ${DATA}/y"`)).toEqual([]);
  });

  it('command substitution is not parsed (accepted false negative)', () => {
    expect(ops(`echo $(rm ${Q}/x)`)).toEqual([]);
  });

  it('segments split on ; && || | & ( ) and newlines', () => {
    expect(splitSegments('a; b && c || d | e & f\ng').map((s) => s.words[0]?.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('cd x && followed by a newline still chains', () => {
    expect(ops(`cd ${Q} &&\nrm wrappers/x.jsonl`)).toEqual(['delete:rm']);
  });

  it('several operations are all reported, each once', () => {
    expect(bash(`rm ${Q}/a && rm ${Q}/b && echo x > ${Q}/c`)?.findings).toEqual([
      { type: 'delete', location: 'Bash', rule: 'rm' },
      { type: 'write', location: 'Bash', rule: '>' },
    ]);
  });
});
