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

/** Tests for argument construction and JSON validation - no editor host needed. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildArguments,
  OmniDiffError,
  DEFAULT_RENDER_OPTIONS,
  isBinaryAvailable,
  parseDiff,
  renderOptionsToml,
} from '../omnidiff';

test('default mode passes no render flag, so omnidiff uses its own persisted setting', () => {
  assert.deepEqual(buildArguments('a.rs', 'b.rs', 'default'), ['--mode', 'json', 'a.rs', 'b.rs']);
});

test('minimal and full are passed through as flags', () => {
  assert.deepEqual(buildArguments('a.rs', 'b.rs', 'minimal'), ['--mode', 'json', '--minimal', 'a.rs', 'b.rs']);
  assert.deepEqual(buildArguments('a.rs', 'b.rs', 'full'), ['--mode', 'json', '--full', 'a.rs', 'b.rs']);
});

test('custom mode passes no preset flag either, so the config file is the only opinion', () => {
  // Load-bearing rather than incidental. `custom` works by handing omnidiff a config file through
  // OMNIDIFF_CONFIG; a `--minimal` or `--full` alongside it would be a second opinion on the same
  // question, and which one wins is not established anywhere. Never combining them means never
  // having to know.
  assert.deepEqual(buildArguments('a.rs', 'b.rs', 'custom'), ['--mode', 'json', 'a.rs', 'b.rs']);
});

test('the generated config carries all six options and nothing else', () => {
  const toml = renderOptionsToml(DEFAULT_RENDER_OPTIONS);
  assert.match(toml, /^\[render_options\]$/m);
  for (const [key, value] of Object.entries(DEFAULT_RENDER_OPTIONS)) {
    assert.match(toml, new RegExp(`^${key} = ${value}$`, 'm'), `${key} missing from the config`);
  }
  // Nothing about themes, layout or recent pairs: this file is written into the user's session and
  // has no business holding an opinion on settings the extension does not offer.
  assert.doesNotMatch(toml, /theme|layout|recent_pairs|palette/);
});

test('the defaults are omnidiff\'s FULL preset, which is not all-true', () => {
  // whole_pair_updates is off in both of omnidiff's presets - it changes which ranges the diff has
  // rather than how much of a decided range is painted. Defaulting all six to true would ship a
  // combination omnidiff itself never uses.
  assert.equal(DEFAULT_RENDER_OPTIONS.whole_pair_updates, false);
  const others = { ...DEFAULT_RENDER_OPTIONS } as Record<string, boolean>;
  delete others['whole_pair_updates'];
  assert.ok(Object.values(others).every((value) => value === true), 'the other five are FULL');
});

test('paths go last, after every flag, and are never concatenated into one string', () => {
  // The property that keeps a path with a space (or a quote) from being re-split by a shell:
  // execFile takes an argv array, and this is the array.
  const args = buildArguments('/tmp/my file.rs', '-weird-name.rs', 'default');
  assert.deepEqual(args.slice(-2), ['/tmp/my file.rs', '-weird-name.rs']);
});

test('a real diff object parses and keeps its hunks', () => {
  const diff = parseDiff(
    JSON.stringify({
      before: { path: 'old.rs', language: 'Rust', hunks: [{ operation: 'delete', range: {} }] },
      after: { path: 'new.rs', language: 'Rust', hunks: [] },
      large_residual: false,
      summary: 'comment_only',
    })
  );
  assert.equal(diff.before.hunks.length, 1);
  assert.equal(diff.summary, 'comment_only');
});

test('a binary-file answer parses - it is a valid diff, not an error', () => {
  const diff = parseDiff(
    JSON.stringify({
      before: { path: 'a.pdf', language: null, hunks: [] },
      after: { path: 'b.pdf', language: null, hunks: [] },
      large_residual: false,
      binary: true,
    })
  );
  assert.equal(diff.binary, true);
});

test('non-JSON output names the likely cause instead of throwing a SyntaxError', () => {
  assert.throws(() => parseDiff('error: unexpected argument\n'), (error: unknown) => {
    assert.ok(error instanceof OmniDiffError);
    assert.match((error as Error).message, /--mode json/);
    return true;
  });
});

test('JSON of the wrong shape is rejected at the boundary, not deep in the decoration code', () => {
  assert.throws(() => parseDiff('[]'), OmniDiffError);
  assert.throws(() => parseDiff('null'), OmniDiffError);
  assert.throws(() => parseDiff('{"before":{"hunks":[]}}'), OmniDiffError);
  assert.throws(() => parseDiff('{"before":{"hunks":[]},"after":{}}'), OmniDiffError);
});

// `node` is guaranteed present here: it is running this test.
test('isBinaryAvailable is true for a binary that exists', async () => {
  assert.equal(await isBinaryAvailable(process.execPath), true);
});

test('isBinaryAvailable is false for a name that is not on PATH', async () => {
  assert.equal(await isBinaryAvailable('omnidiff-does-not-exist-a1b2c3'), false);
});
