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
 * Deciding which `omnidiff` executable to run.
 *
 * Imports `node:fs` and `node:path` but not `vscode`, and takes the extension root and platform as
 * arguments rather than reading them from a host, so it tests under plain `node --test`.
 */

import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where `scripts/fetch-binary.mjs` puts the bundled executable, relative to the extension root. */
export const BUNDLED_DIRECTORY = 'bin';

export type Source = 'setting' | 'bundled' | 'path';

export interface Resolution {
  /** What to spawn: an absolute path for `setting`/`bundled`, a bare name for `path`. */
  command: string;
  source: Source;
}

/** `omnidiff.exe` on Windows, `omnidiff` everywhere else. */
export function bundledName(platform: string): string {
  return platform === 'win32' ? 'omnidiff.exe' : 'omnidiff';
}

export function bundledPath(extensionRoot: string, platform: string): string {
  return join(extensionRoot, BUNDLED_DIRECTORY, bundledName(platform));
}

/**
 * Picks the executable, in the order a user would expect to win.
 *
 * 1. An explicit `omnidiff.binaryPath` setting. It beats the bundle unconditionally, so anyone
 *    running their own build - a debug build, a patched one, a newer release - gets what they
 *    asked for rather than a silently different binary.
 * 2. The bundled binary, if this VSIX carries one. Platform-specific VSIXs do; the target-less
 *    fallback published for architectures with no build does not.
 * 3. `omnidiff` on `PATH`.
 *
 * Step 2 is the reason this exists at all. A VS Code launched from Finder or the Dock does not
 * inherit a login shell's `PATH`, so `~/.cargo/bin/omnidiff` is invisible to it and the extension
 * reports a missing binary the user can plainly run in a terminal.
 *
 * `configured` is compared against the packaged default (`'omnidiff'`) rather than tested for
 * emptiness: VS Code returns the default when nothing is set, so treating that as an explicit
 * choice would let it shadow the bundle for everyone.
 */
export function resolveBinary(
  extensionRoot: string,
  platform: string,
  configured: string | undefined,
  defaultSetting = 'omnidiff'
): Resolution {
  const trimmed = configured?.trim();
  if (trimmed && trimmed !== defaultSetting) {
    return { command: trimmed, source: 'setting' };
  }

  const bundled = bundledPath(extensionRoot, platform);
  if (existsSync(bundled)) {
    return { command: bundled, source: 'bundled' };
  }

  return { command: trimmed || defaultSetting, source: 'path' };
}

/**
 * Makes a bundled binary executable, best-effort.
 *
 * A VSIX is a ZIP, and ZIP only carries Unix mode bits if the writer chose to set them; `vsce`
 * does not reliably, so an extracted binary can land without `+x` and fail at spawn with EACCES on
 * the user's machine long after CI was green. CI asserts the mode inside the packaged VSIX as
 * well - this call masks a broken package, it does not prove a good one.
 *
 * Returns false rather than throwing: on a read-only or managed install the chmod fails, and the
 * caller should fall through to `PATH` instead of the extension refusing to load.
 */
export function ensureExecutable(path: string, platform: string): boolean {
  if (platform === 'win32') {
    return true; // No mode bits to set, and .exe needs none.
  }
  try {
    chmodSync(path, 0o755);
    return true;
  } catch {
    return false;
  }
}
