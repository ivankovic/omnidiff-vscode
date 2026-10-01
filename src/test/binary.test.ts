/*  This file is part of the OmniDiff code diffing tool.
 *
 *  Copyright (C) 2026 Marko Ivankovic
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as published
 *  by the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/** Tests for binary resolution, and for the target table staying in step with CI. */

import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { bundledName, bundledPath, ensureExecutable, resolveBinary } from '../binary';

// `scripts/` is outside tsconfig's rootDir, so the table is read as text rather than imported.
function namesIn(source: string, blockPattern: RegExp, namePattern: RegExp, what: string): string[] {
  const block = blockPattern.exec(source);
  if (!block?.[1]) {
    throw new Error(`could not find ${what}`);
  }
  return [...block[1].matchAll(namePattern)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function repositoryFile(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', '..', ...parts), 'utf8');
}

/** The keys of the TARGETS table in scripts/fetch-binary.mjs. */
function scriptTargets(): string[] {
  return namesIn(
    repositoryFile('scripts', 'fetch-binary.mjs'),
    /export const TARGETS = \{([\s\S]*?)\n\};/,
    /'([\w-]+)':/g,
    'the TARGETS table in scripts/fetch-binary.mjs'
  );
}

/** The `target:` matrix in the release workflow. */
function workflowTargets(): string[] {
  return namesIn(
    repositoryFile('.github', 'workflows', 'release.yml'),
    /target:\n((?:\s*- [\w-]+\n)+)/,
    /- ([\w-]+)/g,
    'the target matrix in .github/workflows/release.yml'
  );
}

let scratch = '';
/** An extension root that carries a bundled binary. */
let withBundle = '';
/** One that does not - the target-less fallback VSIX, or a source checkout. */
let withoutBundle = '';

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'omnidiff-binary-test-'));
  withBundle = join(scratch, 'bundled');
  withoutBundle = join(scratch, 'plain');
  mkdirSync(join(withBundle, 'bin'), { recursive: true });
  mkdirSync(withoutBundle, { recursive: true });
  writeFileSync(join(withBundle, 'bin', 'omnidiff'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(withBundle, 'bin', 'omnidiff.exe'), 'MZ');
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('resolveBinary', () => {
  it('prefers an explicit setting over the bundled binary', () => {
    // Anyone who has pointed the setting at their own build must get that build, not a silently
    // different one - this is the whole reason the setting outranks the bundle.
    const resolved = resolveBinary(withBundle, 'linux', '/opt/mine/omnidiff');
    assert.equal(resolved.source, 'setting');
    assert.equal(resolved.command, '/opt/mine/omnidiff');
  });

  it('treats the packaged default as "no choice made", not as an explicit setting', () => {
    // VS Code hands back the default when nothing is set. Reading that as a choice would shadow
    // the bundle for every user who never touched the setting - i.e. almost all of them.
    assert.equal(resolveBinary(withBundle, 'linux', 'omnidiff').source, 'bundled');
    assert.equal(resolveBinary(withBundle, 'linux', undefined).source, 'bundled');
    assert.equal(resolveBinary(withBundle, 'linux', '   ').source, 'bundled');
  });

  it('uses the bundled binary when one is present', () => {
    const resolved = resolveBinary(withBundle, 'linux', undefined);
    assert.equal(resolved.command, join(withBundle, 'bin', 'omnidiff'));
  });

  it('falls through to PATH when this VSIX carries no binary', () => {
    // The target-less fallback VSIX, published for architectures with no build.
    const resolved = resolveBinary(withoutBundle, 'linux', undefined);
    assert.equal(resolved.source, 'path');
    assert.equal(resolved.command, 'omnidiff');
  });

  it('looks for omnidiff.exe on Windows', () => {
    assert.equal(bundledName('win32'), 'omnidiff.exe');
    assert.equal(bundledName('linux'), 'omnidiff');
    assert.equal(bundledName('darwin'), 'omnidiff');
    assert.equal(resolveBinary(withBundle, 'win32', undefined).command, join(withBundle, 'bin', 'omnidiff.exe'));
  });

  it('does not find a linux binary when running as win32, or the reverse', () => {
    const onlyUnix = join(scratch, 'unix-only');
    mkdirSync(join(onlyUnix, 'bin'), { recursive: true });
    writeFileSync(join(onlyUnix, 'bin', 'omnidiff'), '');
    assert.equal(resolveBinary(onlyUnix, 'win32', undefined).source, 'path');
    assert.equal(resolveBinary(onlyUnix, 'linux', undefined).source, 'bundled');
  });

  it('puts the bundle where fetch-binary.mjs writes it', () => {
    assert.equal(bundledPath('/ext', 'linux'), join('/ext', 'bin', 'omnidiff'));
  });
});

describe('ensureExecutable', () => {
  it('sets the mode bit a VSIX may not have carried', () => {
    const path = join(withBundle, 'bin', 'omnidiff');
    chmodSync(path, 0o644);
    assert.equal(statSync(path).mode & 0o111, 0, 'precondition: not executable');
    assert.equal(ensureExecutable(path, 'linux'), true);
    // 0o111 is the three execute bits. This is the exact state a VSIX can land in - vsce does not
    // reliably carry mode bits into the ZIP - and spawning it would fail with EACCES.
    assert.notEqual(statSync(path).mode & 0o111, 0);
  });

  it('reports failure rather than throwing, so the caller can fall back to PATH', () => {
    assert.equal(ensureExecutable(join(scratch, 'no-such-file'), 'linux'), false);
  });

  it('is a no-op on Windows, which has no mode bits', () => {
    assert.equal(ensureExecutable(join(scratch, 'no-such-file'), 'win32'), true);
  });
});

describe('platform targets', () => {
  it('are the same set in the release workflow and in fetch-binary.mjs', () => {
    // Two files, two syntaxes, one list. A target present in the CI matrix but missing from the
    // script fails the build with "unknown target"; the reverse silently stops publishing a
    // platform, which nobody would notice.
    assert.deepEqual(workflowTargets().sort(), scriptTargets().sort());
  });

  it('do not include alpine-x64', () => {
    // Deliberate: a linux-x64 glibc binary served as alpine-x64 dies on musl with an unreadable
    // loader error. Those users get the target-less fallback VSIX and the PATH lookup instead.
    assert.ok(!scriptTargets().includes('alpine-x64'));
    assert.ok(!workflowTargets().includes('alpine-x64'));
  });

  it('cover the four architectures omnidiff publishes binaries for', () => {
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
      assert.ok(scriptTargets().includes(target), `missing ${target}`);
    }
  });
});
