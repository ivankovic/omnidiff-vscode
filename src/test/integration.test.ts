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
 * The one test that runs the real binary, end to end: spawn omnidiff, parse its JSON, convert its
 * byte column, and land on the right character.
 *
 * **Skipped when omnidiff is not on PATH**, which includes CI unless it installs one - building it
 * takes minutes (every tree-sitter grammar compiles from C, under `lto = "fat"`). That makes this a
 * local-development check rather than a gate, and `node --test` reports it as skipped rather than
 * passing silently. Everything it covers except the spawn itself is also covered by the pure unit
 * tests next door, which do gate.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { byteColumnToUtf16 } from '../columns';
import { renderOptionsToml, runDiff } from '../omnidiff';

function omnidiffAvailable(): boolean {
  try {
    execFileSync('omnidiff', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  'a real diff of a non-ASCII line lands on the right character',
  { skip: omnidiffAvailable() ? false : 'omnidiff not on PATH' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnidiff-vscode-'));
    const before = join(dir, 'before.py');
    const after = join(dir, 'after.py');
    // Three two-byte characters before the change, so a byte column and a UTF-16 column disagree.
    writeFileSync(before, 'x = "ααα" + aaa\n', 'utf8');
    writeFileSync(after, 'x = "ααα" + bbb\n', 'utf8');

    const diff = await runDiff('omnidiff', before, after);
    const hunk = diff.after.hunks[0];
    assert.ok(hunk, 'expected at least one hunk on the after side');

    const line = 'x = "ααα" + bbb';
    const column = byteColumnToUtf16(line, hunk.range.start_column);
    assert.equal(line.slice(column, column + 3), 'bbb');
    // The raw byte column would be 15 and would land three characters late.
    assert.notEqual(column, hunk.range.start_column);
  }
);

/** The two sides of the fixture below: four functions reordered, and one identifier renamed. */
const BEFORE_SOURCE = `import math


def area(width, height):
    return width * height


def perimeter(width, height):
    return 2 * (width + height)


def label(name):
    return "ααα" + name + "ααα"


def diagonal(width, height):
    return math.sqrt(width * width + height * height)
`;

const AFTER_SOURCE = `import math


def diagonal(width, height):
    return math.sqrt(width * width + height * height)


def label(name):
    return "ααα" + caption + "ααα"


def area(width, height):
    return width * height


def perimeter(width, height):
    return 2 * (width + height)
`;

/**
 * omnidiff resolves its own configuration from the nearest `.omnidiff.toml` at or above its
 * working directory, so with `mode` left at `default` - where the whole point is to defer to that
 * configuration - the working directory decides which render options apply, and therefore which
 * hunks come back. Before `runDiff` took a `cwd` it inherited the extension host's, which is
 * wherever VS Code happened to be started from: the painting shown for one pair of files differed
 * between two launches of the same window.
 *
 * The two configurations are all six render options off against all six on, not one field flipped:
 * measured against omnidiff 0.0.12, `paint_displaced_moves` is the only one that changes this
 * fixture *from an all-off baseline* - it is what makes the ` + "ααα"` trailing the renamed
 * identifier a move hunk of its own rather than nothing - but turning only that one off again from
 * an all-on baseline leaves the hunk there, because another option covers the same ground. A
 * single-field difference would therefore pass whether or not `cwd` was honoured at all.
 *
 * Asserted as "one paints more than the other" rather than against fixed counts, because the exact
 * painting is omnidiff's business and moves between releases; that the working directory decides
 * which of the two applies is the part that belongs to this extension.
 */
test(
  'the working directory selects the omnidiff configuration',
  { skip: omnidiffAvailable() ? false : 'omnidiff not on PATH' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnidiff-vscode-cwd-'));
    const before = join(dir, 'before.py');
    const after = join(dir, 'after.py');
    writeFileSync(before, BEFORE_SOURCE, 'utf8');
    writeFileSync(after, AFTER_SOURCE, 'utf8');

    const off = join(dir, 'off');
    const on = join(dir, 'on');
    for (const [directory, enabled] of [
      [off, false],
      [on, true],
    ] as const) {
      mkdirSync(directory);
      writeFileSync(
        join(directory, '.omnidiff.toml'),
        [
          '[render_options]',
          `leading_whitespace = ${enabled}`,
          `structural_punctuation = ${enabled}`,
          `whole_pair_updates = ${enabled}`,
          `paint_reindent_only_moves = ${enabled}`,
          `paint_displaced_moves = ${enabled}`,
          `paint_resized_moves = ${enabled}`,
          '',
        ].join('\n'),
        'utf8'
      );
    }

    const without = await runDiff('omnidiff', before, after, { cwd: off });
    const painted = await runDiff('omnidiff', before, after, { cwd: on });

    assert.ok(
      painted.after.hunks.length > without.after.hunks.length,
      `expected the all-on configuration to paint more: ${painted.after.hunks.length} vs ${without.after.hunks.length}`
    );
  }
);

/**
 * `omnidiff.renderMode: custom` works by writing a config file and pointing `OMNIDIFF_CONFIG` at
 * it, which omnidiff reads before any other layer and without walking up. This is the assertion
 * that the variable actually reaches the process and outranks a `.omnidiff.toml` sitting in the
 * working directory - the whole mechanism is one environment variable, and nothing else here would
 * notice if it stopped being honoured.
 *
 * The directory deliberately contains the *opposite* configuration, so a pass cannot come from the
 * cwd being consulted instead.
 */
test(
  'OMNIDIFF_CONFIG outranks a .omnidiff.toml in the working directory',
  { skip: omnidiffAvailable() ? false : 'omnidiff not on PATH' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnidiff-vscode-env-'));
    const before = join(dir, 'before.py');
    const after = join(dir, 'after.py');
    writeFileSync(before, BEFORE_SOURCE, 'utf8');
    writeFileSync(after, AFTER_SOURCE, 'utf8');

    const all = (enabled: boolean) =>
      renderOptionsToml({
        leading_whitespace: enabled,
        structural_punctuation: enabled,
        whole_pair_updates: enabled,
        paint_reindent_only_moves: enabled,
        paint_displaced_moves: enabled,
        paint_resized_moves: enabled,
      });

    // The working directory says everything on; the environment says everything off.
    const cwd = join(dir, 'cwd');
    mkdirSync(cwd);
    writeFileSync(join(cwd, '.omnidiff.toml'), all(true), 'utf8');
    const override = join(dir, 'override.toml');
    writeFileSync(override, all(false), 'utf8');

    const inherited = await runDiff('omnidiff', before, after, { cwd });
    const overridden = await runDiff('omnidiff', before, after, { cwd, configPath: override });

    assert.ok(
      inherited.after.hunks.length > overridden.after.hunks.length,
      `expected OMNIDIFF_CONFIG to win: ${overridden.after.hunks.length} hunks against the ` +
        `directory's ${inherited.after.hunks.length}`
    );
  }
);
