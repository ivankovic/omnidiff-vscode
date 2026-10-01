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
 * Tests for the byte -> UTF-16 column conversion.
 *
 * Plain `node --test`: `columns.ts` imports nothing, so these need no editor host and no VS Code
 * download - which is what keeps them fast enough to run on every commit.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byteColumnToUtf16 } from '../columns';

/** What `Buffer.byteLength` would say, as an independent check on the hand-rolled `utf8Length`. */
function utf16OffsetOfByte(line: string, byteColumn: number): number {
  let bytes = 0;
  let units = 0;
  for (const character of line) {
    if (bytes >= byteColumn) {
      break;
    }
    bytes += Buffer.byteLength(character, 'utf8');
    units += character.length;
  }
  return units;
}

test('an all-ASCII line is unchanged, which is why the bug hides', () => {
  const line = 'const answer = 42;';
  for (let i = 0; i <= line.length; i++) {
    assert.equal(byteColumnToUtf16(line, i), i);
  }
});

test('the measured real-world case: two-byte characters shift every later column', () => {
  // Verified against the actual binary: `omnidiff --mode json` reports start_column 15 here,
  // where VS Code's Position.character needs 12.
  const line = 'x = "ααα" + bbb';
  assert.equal(Buffer.byteLength(line, 'utf8'), 18);
  assert.equal(line.length, 15);
  assert.equal(byteColumnToUtf16(line, 15), 12);
  assert.equal(byteColumnToUtf16(line, 18), 15);
});

test('three-byte characters (CJK) account for themselves', () => {
  const line = '「日本語」= x';
  assert.equal(byteColumnToUtf16(line, 0), 0);
  // Every character here is 3 bytes except the ASCII tail.
  assert.equal(byteColumnToUtf16(line, 3), 1);
  assert.equal(byteColumnToUtf16(line, 15), 5);
  assert.equal(byteColumnToUtf16(line, Buffer.byteLength(line, 'utf8')), line.length);
});

test('an astral character is 4 bytes and 2 UTF-16 units', () => {
  const line = 'a🎉b';
  assert.equal(Buffer.byteLength(line, 'utf8'), 6);
  assert.equal(line.length, 4); // 'a' + surrogate pair + 'b'
  assert.equal(byteColumnToUtf16(line, 1), 1);
  assert.equal(byteColumnToUtf16(line, 5), 3); // after the emoji
  assert.equal(byteColumnToUtf16(line, 6), 4);
});

test('out-of-range columns clamp instead of throwing', () => {
  const line = 'abc';
  assert.equal(byteColumnToUtf16(line, -1), 0);
  assert.equal(byteColumnToUtf16(line, 0), 0);
  assert.equal(byteColumnToUtf16(line, 999), 3);
  assert.equal(byteColumnToUtf16('', 5), 0);
});

test('a column landing mid-character rounds up to the next boundary', () => {
  // 'α' is bytes 0..2, so byte 1 is inside it. Never emitted by tree-sitter; pinned so the
  // defensive behaviour is deliberate rather than accidental.
  assert.equal(byteColumnToUtf16('αβ', 1), 1);
  assert.equal(byteColumnToUtf16('αβ', 2), 1);
  assert.equal(byteColumnToUtf16('αβ', 3), 2);
});

test('agrees with Buffer.byteLength across a mixed line at every byte offset', () => {
  const line = 'let s = "héllo 世界 🎉"; // ünïcödé';
  const total = Buffer.byteLength(line, 'utf8');
  for (let byteColumn = 0; byteColumn <= total; byteColumn++) {
    assert.equal(
      byteColumnToUtf16(line, byteColumn),
      utf16OffsetOfByte(line, byteColumn),
      `byte column ${byteColumn}`
    );
  }
});
