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
 * Running `omnidiff --mode json` and making sense of what comes back.
 *
 * Imports `node:child_process` but deliberately **not** `vscode`, so every function here is
 * unit-testable under plain `node --test` - see `src/test/`. Anything that needs the editor lives
 * in `extension.ts` or `decorations.ts` instead.
 */

import { execFile } from 'node:child_process';

/** The operations omnidiff's JSON reports. Anything else is a newer omnidiff than this build. */
export type Operation = 'insert' | 'delete' | 'update' | 'move';

export interface JsonRange {
  start_row: number;
  /** A **byte** offset within its row - see `columns.ts` before using it as a VS Code column. */
  start_column: number;
  end_row: number;
  end_column: number;
}

export interface JsonHunk {
  operation: Operation;
  range: JsonRange;
  /** Set only for `move`: the real counterpart range in the other file. */
  move_target?: JsonRange;
  /** Row of the nearest enclosing declaration - omnidiff's `@` breadcrumb, as a number. */
  reference_line?: number;
}

export interface JsonSide {
  path: string;
  language: string | null;
  hunks: JsonHunk[];
}

export interface JsonDiff {
  before: JsonSide;
  after: JsonSide;
  large_residual: boolean;
  /** Present only when the diff has one of omnidiff's recognised overall shapes. */
  summary?: string;
  /** Present, and `true`, only when a side could not be read as text. */
  binary?: boolean;
}

/**
 * Which extra flag, if any, to pass for a configured render mode.
 *
 * `custom` passes no flag at all and is not a preset: it means the six options below are written
 * to a config file of this extension's own, which `OMNIDIFF_CONFIG` then makes authoritative.
 */
export type RenderMode = 'default' | 'minimal' | 'full' | 'custom';

/**
 * The six painting options omnidiff's own settings panel offers, spelled the way its config file
 * spells them.
 *
 * These are the whole of the TUI's `M` panel. Its other settings - theme, custom palette, panel
 * layout, syntax theme, node highlight - describe a terminal UI this extension does not have: VS
 * Code owns the panes, and the colours are contributed colour IDs here rather than a palette of
 * omnidiff's.
 */
export interface RenderOptions {
  leading_whitespace: boolean;
  structural_punctuation: boolean;
  whole_pair_updates: boolean;
  paint_reindent_only_moves: boolean;
  paint_displaced_moves: boolean;
  paint_resized_moves: boolean;
}

/**
 * omnidiff's own defaults, which are its `FULL` preset.
 *
 * Note `whole_pair_updates` is `false` here while the other five are `true`: `FULL` is "the fullest
 * reading of an already-decided range list", and whole-pair updates change which ranges the diff
 * *has*, so it sits on a different axis and is off in both presets. Defaulting all six to `true`
 * would ship a combination omnidiff itself never uses.
 */
export const DEFAULT_RENDER_OPTIONS: RenderOptions = Object.freeze({
  leading_whitespace: true,
  structural_punctuation: true,
  whole_pair_updates: false,
  paint_reindent_only_moves: true,
  paint_displaced_moves: true,
  paint_resized_moves: true,
});

/**
 * The config file contents that pin omnidiff to `options`.
 *
 * Only `[render_options]` is written. Every other field of omnidiff's config has a serde default,
 * so a file carrying just this section is complete as far as deserialization is concerned, and
 * leaving the rest out means this file says nothing about the user's theme or recent pairs - which
 * it has no business having an opinion on.
 */
export function renderOptionsToml(options: RenderOptions): string {
  const lines = ['# Written by the OmniDiff VS Code extension. Edits here are overwritten.', '', '[render_options]'];
  for (const [key, value] of Object.entries(options)) {
    lines.push(`${key} = ${value}`);
  }
  return lines.join('\n') + '\n';
}

export class OmniDiffError extends Error {}

/**
 * Parses omnidiff's stdout into a `JsonDiff`.
 *
 * Validates the shape rather than trusting a cast. The alternative - `JSON.parse(...) as JsonDiff`
 * - turns "the user has an old omnidiff on PATH" into an undefined-property crash somewhere in the
 * decoration code, several steps from the cause. Here it is one message naming the real problem.
 *
 * Unknown `operation` values are **not** an error: they are dropped by the caller (see
 * `decorations.ts`). A released extension has to degrade to painting less when omnidiff grows an
 * operation it does not know, rather than refusing the whole diff.
 */
export function parseDiff(stdout: string): JsonDiff {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new OmniDiffError(
      `omnidiff did not produce JSON. Is '--mode json' supported by your build? (${String(cause)})`
    );
  }

  if (typeof value !== 'object' || value === null) {
    throw new OmniDiffError('omnidiff produced JSON that is not an object.');
  }
  const diff = value as Partial<JsonDiff>;
  for (const key of ['before', 'after'] as const) {
    const side = diff[key];
    if (typeof side !== 'object' || side === null || !Array.isArray(side.hunks)) {
      throw new OmniDiffError(`omnidiff's JSON has no '${key}.hunks' array.`);
    }
  }
  return diff as JsonDiff;
}

/** The argument list for one diff, in the order `omnidiff` expects them. */
export function buildArguments(before: string, after: string, mode: RenderMode): string[] {
  const args = ['--mode', 'json'];
  // `default` deliberately passes neither flag, so omnidiff falls back to whatever the user
  // persisted in its own config - which is what makes the two front ends agree by default.
  //
  // `custom` passes neither either, and that is load-bearing rather than incidental: it works by
  // handing omnidiff a config file through `OMNIDIFF_CONFIG`, and a `--minimal`/`--full` alongside
  // it would be a second opinion on the same question whose precedence nothing here establishes.
  // Never combining them means never needing to know.
  if (mode === 'minimal' || mode === 'full') {
    args.push(`--${mode}`);
  }
  args.push(before, after);
  return args;
}

/**
 * Runs `omnidiff --mode json` on a pair of files and returns the parsed diff.
 *
 * `execFile`, not `exec`: the paths are user data and must never reach a shell. `maxBuffer` is
 * raised well past the 1 MB default because the JSON scales with the number of changed ranges, and
 * the default truncates silently enough to look like a parse bug.
 *
 * `cwd` is not cosmetic. omnidiff resolves its own configuration from the nearest `.omnidiff.toml`
 * at or above the working directory, so with `mode` left at `default` - where the whole point is
 * to defer to that configuration - the working directory decides which render options apply, and
 * therefore which hunks come back. Inherited from the extension host it is whatever directory VS
 * Code happened to be started in, which makes the default painting differ between two launches of
 * the same window. Callers pass the directory of the file being diffed instead.
 */
export interface RunOptions {
  /** Which preset, if any, to force. Defaults to `default` - defer to omnidiff's own config. */
  mode?: RenderMode | undefined;
  /** The directory omnidiff resolves its configuration from. See above. */
  cwd?: string | undefined;
  /**
   * A config file to make authoritative, through `OMNIDIFF_CONFIG`.
   *
   * omnidiff reads that variable before any other config layer and without walking up, so this
   * overrides both the project's `.omnidiff.toml` and the user's own. Only set for `mode: custom`,
   * where overriding is the point; leaving it unset is what keeps a project's config in charge.
   */
  configPath?: string | undefined;
}

export function runDiff(
  binaryPath: string,
  before: string,
  after: string,
  { mode = 'default', cwd, configPath }: RunOptions = {}
): Promise<JsonDiff> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      buildArguments(before, after, mode),
      {
        maxBuffer: 64 * 1024 * 1024,
        cwd,
        // Spread rather than replace: omnidiff needs the inherited environment to find anything at
        // all, PATH included.
        env: configPath ? { ...process.env, OMNIDIFF_CONFIG: configPath } : process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          // ENOENT is the overwhelmingly common failure and deserves its own sentence rather than
          // a raw spawn error, because the fix is "install omnidiff", not "report a bug".
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(
              new OmniDiffError(
                `'${binaryPath}' not found. Install omnidiff (https://github.com/ivankovic/omnidiff) ` +
                  `or set 'omnidiff.binaryPath'.`
              )
            );
            return;
          }
          reject(new OmniDiffError(`omnidiff failed: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          resolve(parseDiff(stdout));
        } catch (cause) {
          reject(cause);
        }
      }
    );
  });
}

/**
 * Whether `binaryPath` resolves to something runnable.
 *
 * Probes with `--help` rather than `--version`: `--version` only exists in builds from 2026-09-10
 * onwards, and reporting "omnidiff is not installed" to someone running a slightly older binary
 * would be worse than not checking at all. Only ENOENT means absent - any other failure (a non-zero
 * exit, a parse error, an unreadable flag) still proves the executable is there.
 */
export function isBinaryAvailable(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binaryPath, ['--help'], (error) => {
      resolve((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT');
    });
  });
}
