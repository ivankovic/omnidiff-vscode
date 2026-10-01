#!/usr/bin/env node
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
 * Downloads the pinned omnidiff release binary for one VS Code target into `bin/`.
 *
 * Usage: `node scripts/fetch-binary.mjs <vsce-target>`, e.g. `linux-x64`.
 *
 * The version comes from `omnidiffVersion` in package.json, never from `latest`: a floating
 * version makes the VSIX unreproducible and couples an extension rebuild to whatever shipped that
 * morning. The download is checked against the release's own SHA256SUMS.txt, which the omnidiff
 * release workflow publishes for exactly this kind of consumer.
 *
 * A release is usable as a pin only if it carries a SHA256SUMS.txt and all five archives,
 * aarch64-unknown-linux-gnu among them; omnidiff's release workflow gained both in v0.0.13, so
 * anything older 404s here - which is the designed failure, rather than quietly producing a VSIX
 * with no binary in it.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'ivankovic/omnidiff';

/**
 * VS Code's target names to Rust's triples.
 *
 * The two namespaces are unrelated and neither is derivable from the other, so the mapping is
 * written out once, here, and the CI matrix reads its target names from the same table.
 *
 * `alpine-x64` is deliberately absent. VS Code Remote containers are often Alpine, and a
 * `linux-x64` VSIX carries a glibc binary that dies on musl with a loader error nobody can read.
 * Publishing nothing for that target makes the Marketplace serve the target-less fallback VSIX
 * instead, which finds omnidiff on PATH like any other unbundled install.
 */
export const TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

function fail(message) {
  console.error(`fetch-binary: ${message}`);
  process.exit(1);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    fail(`GET ${url} returned ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    fail(`no target given. One of: ${Object.keys(TARGETS).join(', ')}`);
  }
  const triple = TARGETS[target];
  if (!triple) {
    fail(`unknown target '${target}'. One of: ${Object.keys(TARGETS).join(', ')}`);
  }

  const root = new URL('..', import.meta.url).pathname;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = manifest.omnidiffVersion;
  if (!version) {
    fail('package.json has no `omnidiffVersion` field to pin the download to.');
  }

  const windows = target.startsWith('win32');
  const archive = `omnidiff-${triple}.${windows ? 'zip' : 'tar.gz'}`;
  const base = `https://github.com/${REPOSITORY}/releases/download/${version}`;

  console.log(`fetch-binary: ${archive} from ${version}`);
  const bytes = await download(`${base}/${archive}`);

  // Checked against the release's own manifest rather than a hash committed here: this script has
  // to keep working when `omnidiffVersion` is bumped, and a hardcoded digest would have to be
  // updated in lockstep or silently start failing.
  const sums = (await download(`${base}/SHA256SUMS.txt`)).toString('utf8');
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === archive)?.[0];
  if (!expected) {
    fail(`SHA256SUMS.txt for ${version} lists no entry for ${archive}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    fail(`checksum mismatch for ${archive}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`fetch-binary: sha256 ok (${actual.slice(0, 16)}…)`);

  const binDirectory = join(root, 'bin');
  rmSync(binDirectory, { recursive: true, force: true });
  mkdirSync(binDirectory, { recursive: true });

  const archivePath = join(binDirectory, archive);
  writeFileSync(archivePath, bytes);
  if (windows) {
    execFileSync('unzip', ['-q', '-o', archivePath, '-d', binDirectory], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['xzf', archivePath, '-C', binDirectory], { stdio: 'inherit' });
  }
  rmSync(archivePath);

  // Set here as well as at activation. `vsce` does not reliably carry mode bits into the ZIP, so
  // the extension chmods what it finds - but starting from a non-executable file makes the
  // packaged VSIX depend entirely on that fallback working.
  const binary = join(binDirectory, windows ? 'omnidiff.exe' : 'omnidiff');
  execFileSync('chmod', ['755', binary]);
  console.log(`fetch-binary: wrote ${binary}`);
}

// Only when run as a script. `TARGETS` is imported by the test that checks the CI matrix has not
// drifted from this table, and importing must not start a download.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.message));
}
