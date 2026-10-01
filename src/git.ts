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
 * Reading files out of git, and putting them somewhere omnidiff can diff.
 *
 * Imports `node:child_process`, `node:fs` and `node:path`, but not `vscode`, so all of it is
 * testable under plain `node --test` against a real throwaway repository - see `src/test/git.test.ts`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export class GitError extends Error {}

/** Large enough for any single source file; `git show` on a big blob otherwise truncates silently. */
const MAX_BUFFER = 64 * 1024 * 1024;

function run(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `encoding: 'buffer'` is load-bearing, not a micro-optimisation. The default decodes stdout as
    // UTF-8, which corrupts a file with a BOM, a non-UTF-8 encoding, or any binary content - and we
    // would then write that corruption to disk and diff something git never had. omnidiff answers
    // `{"binary": true}` correctly when it sees real bytes; decoding here would take that away.
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GitError('git was not found on PATH.'));
          return;
        }
        reject(new GitError(stderr.toString('utf8').trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The working-tree root of the repository containing `filePath`.
 *
 * Fails with a sentence rather than git's own message, because "not a git repository" arrives here
 * as a normal outcome (someone ran the command on a scratch file) rather than as a fault.
 */
export async function repositoryRoot(filePath: string): Promise<string> {
  try {
    const stdout = await run(['rev-parse', '--show-toplevel'], dirname(filePath));
    return stdout.toString('utf8').trim();
  } catch (cause) {
    throw new GitError(
      cause instanceof GitError && cause.message.includes('not found on PATH')
        ? cause.message
        : `${basename(filePath)} is not inside a git repository.`
    );
  }
}

/**
 * `filePath` as git names it: relative to `root`, with forward slashes on every platform.
 *
 * `git show <ref>:<path>` will not accept a backslash-separated path even on Windows, which is the
 * kind of thing that works throughout development on Linux and then fails for every Windows user.
 */
export function relativeToRoot(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

/**
 * The bytes of `relPath` as of `ref`.
 *
 * A file that exists in the working tree but not at `ref` - anything newly added - is the common
 * case here and gets its own sentence; git's own message for it names an object hash and helps
 * nobody.
 */
export async function showAtRevision(root: string, ref: string, relPath: string): Promise<Buffer> {
  try {
    return await run(['show', `${ref}:${relPath}`], root);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/does not exist|exists on disk, but not in|unknown revision|invalid object name/i.test(message)) {
      throw new GitError(`${relPath} is not in ${ref} - it may be a new file, or ${ref} may not exist.`);
    }
    throw cause;
  }
}

/**
 * Writes `bytes` into `intoDir` under `originalPath`'s **exact basename**, and returns the path.
 *
 * The basename is the whole point. omnidiff picks a tree-sitter grammar from the path (see its
 * `language_for_path_and_content`, which also sniffs content for ambiguous extensions like `.ts`),
 * so a blob written to a scratch name gets no grammar, silently falls back to a plain line diff,
 * and the tool merely looks worse rather than broken. git's own difftool does the same thing for
 * the same reason - and omnidiff's README says so about jj: it needs each file's real path and
 * extension for language detection to work.
 *
 * `intoDir` has to disambiguate everything the basename no longer can. Two axes collide: the same
 * file at two revisions, and two *different* files sharing a basename at one revision - `mod.rs`
 * appears dozens of times in a Rust tree, as do `index.ts`, `__init__.py` and `main.go`. Callers
 * therefore build it from both the revision (`revisionDirectory`) and the file's directory within
 * the repository. Getting this wrong overwrites a file an editor is already showing, and VS Code
 * reloads that pane with the other file's content.
 */
export function materialize(bytes: Buffer, originalPath: string, intoDir: string): string {
  mkdirSync(intoDir, { recursive: true });
  const target = join(intoDir, basename(originalPath));
  writeFileSync(target, bytes);
  return target;
}

/**
 * A directory name for `ref`, safe on every filesystem.
 *
 * Refs may contain `/` (`origin/main`) and `~`/`^` (`HEAD~2`), none of which can go in a path
 * segment unescaped. The label stays readable because it shows up in the editor tab.
 *
 * Sanitising can in principle map two refs onto one directory (`HEAD~` and `HEAD^` both become
 * `HEAD_`), which is harmless here: the pairs that collide are ones that differ only in separator
 * characters, and the caller passes a fresh `base` per session anyway.
 */
export function revisionDirectory(base: string, ref: string): string {
  const segment = ref.replace(/[^\w.-]+/g, '_');
  // Not a non-empty check, and deliberately not `\w` either - `\w` includes `_`, so `///`
  // sanitises to `_` and would sail through as a "valid" name nobody could recognise in a tab.
  return join(base, /[A-Za-z0-9]/.test(segment) ? segment : 'rev');
}
