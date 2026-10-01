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
 * Byte columns to UTF-16 code units.
 *
 * This is the single most likely thing for an omnidiff integration to get wrong, and it is
 * invisible until it isn't: **omnidiff reports columns as byte offsets within their row** - that
 * is what tree-sitter's `Point::column` gives and what its `SourceColumn` type documents - while
 * VS Code's `Position.character` counts UTF-16 code units. They agree exactly as long as every
 * character on the line is ASCII, and diverge the moment one is not.
 *
 * Measured against the real binary: for the line `x = "ααα" + bbb`, omnidiff reports
 * `start_column: 15` where VS Code needs `12`. Without this conversion every range on every line
 * containing a non-ASCII character lands somewhere else, and nothing about the failure points at
 * the cause.
 *
 * Neovim needs no equivalent - `nvim_buf_set_extmark` takes byte columns directly - which is why
 * omnidiff emits bytes rather than adding a second coordinate space it could disagree with itself
 * about. The conversion belongs here.
 */

/**
 * The UTF-16 offset within `line` corresponding to UTF-8 byte offset `byteColumn`.
 *
 * Clamps rather than throwing at both ends: a `byteColumn` past the end of the line returns the
 * line's full UTF-16 length, and a negative one returns 0. omnidiff should never emit either, but
 * an out-of-range column is not worth failing a whole diff over - VS Code clamps invalid positions
 * to the document anyway, so throwing here would turn a cosmetic problem into a missing diff.
 *
 * A `byteColumn` landing *inside* a multi-byte character rounds up to the next character boundary.
 * tree-sitter never reports a column mid-character, so this is a defensive choice rather than a
 * meaningful one; rounding up is the safer direction because it never truncates a character out of
 * a highlight that was meant to contain it.
 */
export function byteColumnToUtf16(line: string, byteColumn: number): number {
  if (byteColumn <= 0) {
    return 0;
  }

  let bytes = 0;
  let units = 0;
  // `for...of` over a string iterates by code point, so an astral character (an emoji, say) is
  // one iteration contributing 4 bytes and 2 UTF-16 units - which is exactly the accounting
  // needed here, and is why this is not a `for (let i = 0; i < line.length; i++)` loop.
  for (const character of line) {
    if (bytes >= byteColumn) {
      break;
    }
    bytes += utf8Length(character);
    units += character.length;
  }
  return units;
}

/**
 * UTF-8 byte length of a single code point.
 *
 * Hand-rolled rather than `Buffer.byteLength(character, 'utf8')` so this module imports nothing -
 * not `vscode`, not `node:buffer` - which is what lets its tests run under plain `node --test`
 * with no editor host and no VS Code download. The four branches are the UTF-8 encoding's own
 * size classes.
 */
function utf8Length(character: string): number {
  const code = character.codePointAt(0);
  if (code === undefined) {
    return 0;
  }
  if (code <= 0x7f) {
    return 1;
  }
  if (code <= 0x7ff) {
    return 2;
  }
  if (code <= 0xffff) {
    return 3;
  }
  return 4;
}
