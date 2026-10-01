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

/**
 * Tests for `src/git.ts`, against a real throwaway repository.
 *
 * Unlike the omnidiff integration test, this one does not skip when its dependency is missing: git
 * is a hard requirement of the commands under test and of anyone developing the extension, so a
 * machine without it should fail here rather than quietly report a pass.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  GitError,
  materialize,
  relativeToRoot,
  repositoryRoot,
  revisionDirectory,
  showAtRevision,
} from '../git';

let root = '';
let scratch = '';

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'omnidiff-git-test-'));
  root = join(scratch, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });

  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  // Signing would prompt or fail on a machine configured to sign every commit.
  git('config', 'commit.gpgsign', 'false');

  writeFileSync(join(root, 'src', 'parser.ts'), 'const committed = 1;\n');
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]));
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');

  // The working tree now differs from HEAD, which is the situation every command here is for.
  writeFileSync(join(root, 'src', 'parser.ts'), 'const working = 2;\n');
  writeFileSync(join(root, 'src', 'added.ts'), 'const untracked = 3;\n');
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('repositoryRoot', () => {
  it('finds the root from a file in a subdirectory', async () => {
    // `git rev-parse` resolves symlinks (/tmp is one on macOS), so compare against git's own answer.
    const expected = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root })
      .toString()
      .trim();
    assert.equal(await repositoryRoot(join(root, 'src', 'parser.ts')), expected);
  });

  it('explains itself when the file is not in a repository', async () => {
    const orphan = join(scratch, 'orphan.ts');
    writeFileSync(orphan, 'const x = 1;\n');
    await assert.rejects(() => repositoryRoot(orphan), (error: Error) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /orphan\.ts is not inside a git repository/);
      return true;
    });
  });
});

describe('relativeToRoot', () => {
  it('is relative to the root', () => {
    assert.equal(relativeToRoot('/a/b', '/a/b/src/parser.ts'), 'src/parser.ts');
  });

  it('uses forward slashes, because git will not take anything else', () => {
    assert.ok(!relativeToRoot('/a/b', join('/a/b', 'src', 'parser.ts')).includes('\\'));
  });
});

describe('showAtRevision', () => {
  it('returns the committed content, not the working copy', async () => {
    const bytes = await showAtRevision(root, 'HEAD', 'src/parser.ts');
    assert.equal(bytes.toString('utf8'), 'const committed = 1;\n');
    assert.notEqual(bytes.toString('utf8'), readFileSync(join(root, 'src', 'parser.ts'), 'utf8'));
  });

  it('returns bytes unmangled, so binary files stay binary', async () => {
    // The whole reason `run` asks execFile for a Buffer: decoding this as UTF-8 replaces 0xff/0xfe
    // with U+FFFD, and we would then write the replacement characters to disk and diff a file git
    // never had.
    const bytes = await showAtRevision(root, 'HEAD', 'binary.dat');
    assert.deepEqual([...bytes], [0x00, 0x01, 0xff, 0xfe, 0x00]);
  });

  it('says a file is new rather than passing on git object-hash noise', async () => {
    await assert.rejects(() => showAtRevision(root, 'HEAD', 'src/added.ts'), (error: Error) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /is not in HEAD - it may be a new file/);
      return true;
    });
  });

  it('reports an unknown revision through the same sentence', async () => {
    await assert.rejects(() => showAtRevision(root, 'no-such-ref', 'src/parser.ts'), (error: Error) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /no-such-ref may not exist/);
      return true;
    });
  });
});

describe('materialize', () => {
  it('keeps the original basename, so omnidiff can still pick a grammar', () => {
    const into = join(scratch, 'materialize-basename');
    const written = materialize(Buffer.from('x\n'), '/somewhere/else/parser.ts', into);
    assert.equal(written, join(into, 'parser.ts'));
    assert.equal(readFileSync(written, 'utf8'), 'x\n');
  });

  it('creates the directory it is given', () => {
    const into = join(scratch, 'deep', 'nested', 'dir');
    const written = materialize(Buffer.from('x\n'), 'a.ts', into);
    assert.equal(readFileSync(written, 'utf8'), 'x\n');
  });

  it('writes bytes verbatim', () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe]);
    const written = materialize(bytes, 'blob.dat', join(scratch, 'materialize-bytes'));
    assert.deepEqual([...readFileSync(written)], [...bytes]);
  });

  it('keeps two different files that share a basename apart', () => {
    // The other collision axis, and the common one: `mod.rs` appears dozens of times in a Rust
    // tree. Both files at one revision must not land on the same path, or the second diff
    // overwrites a file the first still has open and VS Code reloads that pane with the wrong
    // content. The caller disambiguates with the file's directory inside the repository.
    const revision = revisionDirectory(join(scratch, 'shared-basename'), 'HEAD');
    const tui = materialize(Buffer.from('tui\n'), '/r/src/tui/mod.rs', join(revision, 'src/tui'));
    const diff = materialize(Buffer.from('diff\n'), '/r/src/diff/mod.rs', join(revision, 'src/diff'));
    assert.notEqual(tui, diff);
    assert.equal(readFileSync(tui, 'utf8'), 'tui\n');
    assert.equal(readFileSync(diff, 'utf8'), 'diff\n');
    // Both still end in the real basename, which is what omnidiff reads for the grammar.
    assert.ok(tui.endsWith('mod.rs') && diff.endsWith('mod.rs'));
  });

  it('lets two revisions of one file coexist under different directories', () => {
    const base = join(scratch, 'two-revisions');
    const head = materialize(Buffer.from('old\n'), 'parser.ts', revisionDirectory(base, 'HEAD'));
    const older = materialize(Buffer.from('older\n'), 'parser.ts', revisionDirectory(base, 'HEAD~2'));
    assert.notEqual(head, older);
    assert.equal(readFileSync(head, 'utf8'), 'old\n');
    assert.equal(readFileSync(older, 'utf8'), 'older\n');
  });
});

describe('revisionDirectory', () => {
  it('keeps a plain ref readable, because it shows in the editor tab', () => {
    assert.equal(revisionDirectory('/base', 'HEAD'), join('/base', 'HEAD'));
    assert.equal(revisionDirectory('/base', 'v1.2.3'), join('/base', 'v1.2.3'));
  });

  it('flattens the characters that cannot be a path segment', () => {
    // `origin/main` would otherwise become a nested directory, and `HEAD~2`/`HEAD^` are awkward
    // to quote on every shell that might later touch these paths.
    for (const ref of ['origin/main', 'HEAD~2', 'HEAD^', 'feature/a b']) {
      const segment = revisionDirectory('/base', ref).slice('/base/'.length);
      assert.ok(!/[/\\~^ ]/.test(segment), `${ref} produced ${segment}`);
    }
  });

  it('never produces an empty segment', () => {
    assert.equal(revisionDirectory('/base', '///'), join('/base', 'rev'));
  });
});
