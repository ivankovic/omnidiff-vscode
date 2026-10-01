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
 * Extension entry point: command registration and the editor-facing glue.
 *
 * Everything that can be tested without an editor lives in `omnidiff.ts`, `columns.ts` and
 * `git.ts`; this file is deliberately thin, because nothing in it can run under `node --test`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as vscode from 'vscode';

import { ensureExecutable, resolveBinary, type Resolution } from './binary';
import {
  OmniDiffError,
  DEFAULT_RENDER_OPTIONS,
  isBinaryAvailable,
  renderOptionsToml,
  runDiff,
  type RenderMode,
  type RenderOptions,
} from './omnidiff';
import { applyHunks, clear, createDecorationTypes, type DecorationTypes } from './decorations';
import {
  GitError,
  materialize,
  relativeToRoot,
  repositoryRoot,
  revisionDirectory,
  showAtRevision,
} from './git';

const INSTALL_URL = 'https://github.com/ivankovic/omnidiff#installation';

/** How long an abandoned scratch directory survives. See `sweepScratch`. */
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function renderMode(): RenderMode {
  return vscode.workspace.getConfiguration('omnidiff').get<RenderMode>('renderMode', 'default');
}

/**
 * The six painting options, read from the settings.
 *
 * Keyed by omnidiff's own field names on one side and the settings' camelCase on the other, in one
 * table, so adding an option is one line rather than two that can disagree.
 */
const RENDER_SETTINGS: ReadonlyArray<readonly [keyof RenderOptions, string]> = [
  ['leading_whitespace', 'leadingWhitespace'],
  ['structural_punctuation', 'structuralPunctuation'],
  ['whole_pair_updates', 'wholePairUpdates'],
  ['paint_reindent_only_moves', 'paintReindentOnlyMoves'],
  ['paint_displaced_moves', 'paintDisplacedMoves'],
  ['paint_resized_moves', 'paintResizedMoves'],
];

/**
 * The settings section from before the rename to OmniDiff (v0.2.0), and the keys it had.
 *
 * Read once at activation: each value set at user or workspace scope is copied to the same
 * `omnidiff.*` key when that one is unset there, so an upgrade keeps its settings. The old values
 * stay where they are; VS Code greys them out as unknown. Remove after one release.
 */
const LEGACY_SECTION = 'codediff';
const LEGACY_KEYS = [
  'binaryPath',
  'renderMode',
  ...RENDER_SETTINGS.map(([, setting]) => `render.${setting}`),
];

async function adoptLegacySettings(): Promise<void> {
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
  const current = vscode.workspace.getConfiguration('omnidiff');
  for (const key of LEGACY_KEYS) {
    const before = legacy.inspect(key);
    const now = current.inspect(key);
    if (before?.globalValue !== undefined && now?.globalValue === undefined) {
      await current.update(key, before.globalValue, vscode.ConfigurationTarget.Global);
    }
    if (before?.workspaceValue !== undefined && now?.workspaceValue === undefined) {
      await current.update(key, before.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  }
}

/**
 * Writes the config file that `omnidiff.renderMode: custom` runs against, and returns its path.
 *
 * Named after a hash of its own contents rather than written to one fixed path: two windows
 * diffing at the same moment with different settings would otherwise race on that file, and the
 * loser would paint with the winner's options. Identical settings reuse one file, so this is a
 * handful of small files per session at worst, swept with the rest of the scratch directory.
 */
function writeRenderConfig(session: string): string {
  const configured = vscode.workspace.getConfiguration('omnidiff.render');
  const options = { ...DEFAULT_RENDER_OPTIONS };
  for (const [field, setting] of RENDER_SETTINGS) {
    options[field] = configured.get<boolean>(setting, DEFAULT_RENDER_OPTIONS[field]);
  }

  const contents = renderOptionsToml(options);
  const directory = join(session, 'config');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${createHash('sha256').update(contents).digest('hex').slice(0, 16)}.toml`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

/**
 * Which binary to run, re-resolved per call so a settings change takes effect without a reload.
 *
 * The chmod happens here rather than once at activation because the bundle only needs it when it
 * is actually the thing being spawned, and a failure has to fall through to `PATH` rather than
 * stop the extension loading - see `ensureExecutable`.
 */
function binary(extensionRoot: string): Resolution {
  const configured = vscode.workspace.getConfiguration('omnidiff').get<string>('binaryPath');
  const resolution = resolveBinary(extensionRoot, process.platform, configured);
  if (resolution.source === 'bundled' && !ensureExecutable(resolution.command, process.platform)) {
    return { command: 'omnidiff', source: 'path' };
  }
  return resolution;
}

/**
 * One side of a diff.
 *
 * `diffPath` and `display` are separate because they genuinely differ: when the content being
 * diffed is an unsaved buffer, omnidiff has to read a temp copy of it (the CLI reads files from
 * disk and cannot see a dirty buffer), while the editor we paint must be the user's real one.
 */
interface Side {
  /** The file handed to the omnidiff CLI. */
  diffPath: string;
  /** The document opened and painted. */
  display: vscode.Uri;
  /** Where to put it if it is not already on screen. */
  column: vscode.ViewColumn;
}

/**
 * Reuses an already-visible editor for `side.display` rather than opening a second one.
 *
 * Without this, diffing an unsaved buffer would move the user's own editor into column Two and
 * paint a different instance of it than the one they are typing in.
 */
async function openSide(side: Side): Promise<vscode.TextEditor> {
  const visible = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === side.display.toString()
  );
  if (visible) {
    return visible;
  }
  return vscode.window.showTextDocument(side.display, { viewColumn: side.column, preview: false });
}

/**
 * The directory omnidiff should resolve its own configuration from.
 *
 * omnidiff looks for the nearest `.omnidiff.toml` at or above its working directory, so this is
 * what decides the render options behind `omnidiff.renderMode: default` - and the extension host's
 * inherited working directory is no answer at all, being wherever VS Code was started from. The
 * file under the cursor is, because its project's config is the one the user means.
 *
 * The *after* side is preferred: `before` is frequently a blob materialised out of git into the
 * extension's own storage, which is in nobody's project. `undefined` - meaning "inherit", the old
 * behaviour - is returned only when neither side is a real file on disk.
 */
function configDirectory(before: Side, after: Side): string | undefined {
  const onDisk = [after, before].find((side) => side.display.scheme === 'file');
  return onDisk ? dirname(onDisk.display.fsPath) : undefined;
}

/**
 * Runs omnidiff over the two sides and paints its verdict on both.
 *
 * Deliberately not VS Code's own `vscode.diff` command: that opens a *merged* diff editor whose
 * two sides are one editor, and `setDecorations` needs a `TextEditorDecorationType` per real
 * editor. Two normal editors in two columns is what makes per-side highlighting possible at all.
 */
async function diffSides(
  before: Side,
  after: Side,
  types: DecorationTypes,
  extensionRoot: string,
  session: string
): Promise<void> {
  const { command } = binary(extensionRoot);
  const mode = renderMode();

  const diff = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'OmniDiff: diffing…' },
    () =>
      runDiff(command, before.diffPath, after.diffPath, {
        mode,
        cwd: configDirectory(before, after),
        configPath: mode === 'custom' ? writeRenderConfig(session) : undefined,
      })
  );

  if (diff.binary) {
    void vscode.window.showInformationMessage('OmniDiff: one of these files is binary - nothing to show.');
    return;
  }

  const beforeEditor = await openSide(before);
  const afterEditor = await openSide(after);

  applyHunks(beforeEditor, diff.before.hunks, types);
  applyHunks(afterEditor, diff.after.hunks, types);

  if (diff.summary) {
    vscode.window.setStatusBarMessage(`OmniDiff: ${diff.summary.replace(/_/g, ' ')}`, 5000);
  }
}

function fileSide(path: string, column: vscode.ViewColumn): Side {
  return { diffPath: path, display: vscode.Uri.file(path), column };
}

/** Asks for two files, because the palette command has no context to work from. */
async function promptForPair(): Promise<[vscode.Uri, vscode.Uri] | undefined> {
  const before = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select the BEFORE file',
    title: 'OmniDiff: before',
  });
  if (!before?.[0]) {
    return undefined;
  }
  const after = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select the AFTER file',
    title: 'OmniDiff: after',
  });
  if (!after?.[0]) {
    return undefined;
  }
  return [before[0], after[0]];
}

/**
 * The file a command should act on: the one right-clicked in the SCM view, else the active editor.
 *
 * The SCM menu hands the command its resource state, which is duck-typed here rather than typed
 * against the git extension's `git.d.ts`. Vendoring that file would buy an index-vs-HEAD
 * distinction this extension does not make, at the cost of depending on another extension's
 * private API being present and enabled.
 */
function targetUri(argument: unknown): vscode.Uri | undefined {
  const resourceUri = (argument as { resourceUri?: unknown } | undefined)?.resourceUri;
  if (resourceUri instanceof vscode.Uri) {
    return resourceUri;
  }
  if (argument instanceof vscode.Uri) {
    return argument;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

/**
 * Deletes scratch directories left behind by earlier sessions.
 *
 * By age rather than by "not mine", because a second VS Code window may be running its own session
 * right now with editors open on its temp files - deleting those would blank a document someone is
 * reading. Cleaning up at shutdown is not an option either: `deactivate` is not guaranteed to run,
 * and a file cannot be removed while an editor still shows it.
 */
function sweepScratch(root: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // Nothing has been written yet.
  }
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A directory another window is using may vanish under us; that is the outcome we wanted.
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  void adoptLegacySettings().catch(() => undefined);
  const types = createDecorationTypes();
  const extensionRoot = context.extensionPath;
  // Registered on the context so VS Code disposes them with the extension; a leaked decoration
  // type keeps painting after a reload.
  for (const type of Object.values(types)) {
    context.subscriptions.push(type);
  }

  // `storageUri` is undefined when no folder is open, and both may not exist yet.
  const scratchRoot = join((context.storageUri ?? context.globalStorageUri).fsPath, 'scratch');
  sweepScratch(scratchRoot);
  const session = join(scratchRoot, `session-${process.pid}-${Date.now()}`);

  /**
   * Marks the session directory as in use.
   *
   * A directory's mtime only tracks its *direct* children, so writing `session/HEAD/parser.ts`
   * bumps `session/HEAD` and leaves `session` frozen at creation time. A window left open past
   * `SCRATCH_MAX_AGE_MS` would otherwise have its still-referenced files swept by the next one.
   */
  function touchSession(): void {
    try {
      const now = new Date();
      utimesSync(session, now, now);
    } catch {
      // Nothing has been written to it yet, or it is gone; either way there is nothing to protect.
    }
  }

  /** Materialises `uri` as of `ref` and diffs it against the file on disk. */
  async function diffAgainstRevision(uri: vscode.Uri, ref: string): Promise<void> {
    const root = await repositoryRoot(uri.fsPath);
    const relative = relativeToRoot(root, uri.fsPath);
    const bytes = await showAtRevision(root, ref, relative);
    // The file's own directory goes under the revision directory: without it, `src/tui/mod.rs`
    // and `src/diff/mod.rs` both land on `HEAD/mod.rs`, and the second diff overwrites a file the
    // first one still has open - VS Code reloads that pane with the wrong content. `dirname` of a
    // repository-root file is `.`, which `join` absorbs.
    const materialized = materialize(
      bytes,
      uri.fsPath,
      join(revisionDirectory(session, ref), dirname(relative))
    );
    touchSession();
    await diffSides(
      fileSide(materialized, vscode.ViewColumn.One),
      { diffPath: uri.fsPath, display: uri, column: vscode.ViewColumn.Two },
      types,
      extensionRoot,
      session
    );
  }

  /** Diffs the last saved bytes of `document` against what is currently in the buffer. */
  async function diffAgainstSaved(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      throw new OmniDiffError('OmniDiff: this document is not a file on disk.');
    }
    if (!document.isDirty) {
      void vscode.window.showInformationMessage('OmniDiff: no unsaved changes in this file.');
      return;
    }

    const saved = join(session, 'saved', String(Date.now()));
    const savedPath = materialize(readFileSync(document.uri.fsPath), document.uri.fsPath, saved);

    // The CLI reads from disk and cannot see the buffer, so the unsaved text has to be spilled to
    // a temp file - but the editor we paint is still the user's own, via `Side.display`.
    //
    // Written as UTF-8, which is what `getText` gives back regardless of how the file was decoded.
    // For a file in some other encoding that makes the two sides disagree about non-ASCII bytes;
    // the saved side is the one that is literally correct, and omnidiff itself assumes UTF-8.
    const bufferPath = materialize(
      Buffer.from(document.getText(), 'utf8'),
      document.uri.fsPath,
      join(session, 'buffer', String(Date.now()))
    );
    touchSession();

    await diffSides(
      fileSide(savedPath, vscode.ViewColumn.One),
      { diffPath: bufferPath, display: document.uri, column: vscode.ViewColumn.Two },
      types,
      extensionRoot,
      session
    );
  }

  /**
   * Turns a thrown error into one message aimed at the user.
   *
   * `OmniDiffError` and `GitError` already read as sentences; anything else is a bug and keeps its
   * raw text rather than a friendly rewrite that would hide it. A missing binary is the one case
   * worth an action button, since there is something concrete to do about it.
   */
  async function report(error: unknown): Promise<void> {
    // Only an OmniDiffError gets the install offer. A GitError saying "git was not found on PATH"
    // matches the same words but is about a different program entirely, and offering omnidiff's
    // install page plus the `omnidiff.binaryPath` setting would send the user somewhere useless.
    if (error instanceof OmniDiffError && /not (?:be )?found|is not installed|ENOENT/i.test(error.message)) {
      await offerInstall(error.message);
      return;
    }
    if (error instanceof OmniDiffError || error instanceof GitError) {
      void vscode.window.showErrorMessage(error.message);
      return;
    }
    void vscode.window.showErrorMessage(`OmniDiff: ${String(error)}`);
  }

  async function offerInstall(message: string): Promise<void> {
    const choice = await vscode.window.showErrorMessage(message, 'Install instructions', 'Set path…');
    if (choice === 'Install instructions') {
      await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
    } else if (choice === 'Set path…') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'omnidiff.binaryPath');
    }
  }

  /** Wraps a command body so every one of them reports failures the same way. */
  function command(name: string, body: (argument: unknown) => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(name, async (argument: unknown) => {
      try {
        await body(argument);
      } catch (error) {
        await report(error);
      }
    });
  }

  function requireTarget(argument: unknown): vscode.Uri {
    const uri = targetUri(argument);
    if (!uri) {
      throw new OmniDiffError('OmniDiff: open a file first, or pick one in the Source Control view.');
    }
    return uri;
  }

  context.subscriptions.push(
    command('omnidiff.diffTwoFiles', async () => {
      const pair = await promptForPair();
      if (!pair) {
        return;
      }
      await diffSides(
        { diffPath: pair[0].fsPath, display: pair[0], column: vscode.ViewColumn.One },
        { diffPath: pair[1].fsPath, display: pair[1], column: vscode.ViewColumn.Two },
        types,
        extensionRoot,
        session
      );
    }),

    command('omnidiff.diffWithHead', async (argument) => {
      await diffAgainstRevision(requireTarget(argument), 'HEAD');
    }),

    command('omnidiff.diffWithRevision', async (argument) => {
      const uri = requireTarget(argument);
      const ref = await vscode.window.showInputBox({
        title: 'OmniDiff: diff against revision',
        prompt: 'A branch, tag, or commit - anything `git show` accepts.',
        value: 'HEAD~1',
        ignoreFocusOut: true,
      });
      if (!ref?.trim()) {
        return;
      }
      await diffAgainstRevision(uri, ref.trim());
    }),

    command('omnidiff.diffWithSaved', async (argument) => {
      const uri = requireTarget(argument);
      // Right-clicking a tab does not focus it, so this command cannot just read
      // `activeTextEditor` - it has to find the document the menu actually pointed at.
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri.toString()
      );
      if (!document) {
        throw new OmniDiffError('OmniDiff: that file is not open, so it has no unsaved changes.');
      }
      await diffAgainstSaved(document);
    }),

    vscode.commands.registerCommand('omnidiff.clearDecorations', () => {
      for (const editor of vscode.window.visibleTextEditors) {
        clear(editor, types);
      }
    })
  );

  // Checked once here rather than before every diff: activation is already lazy (it happens on the
  // first command), so this costs one process at the moment the user first asks for something, and
  // tells them what is wrong before they wonder why nothing painted.
  const resolved = binary(extensionRoot);
  void isBinaryAvailable(resolved.command).then((available) => {
    if (available) {
      return;
    }
    // Only the `path` case is worth an install offer. A bundled binary that fails to run is a
    // broken package rather than a missing prerequisite, and an explicit setting that does not
    // resolve is a typo in that setting - neither is fixed by omnidiff's install page.
    if (resolved.source === 'path') {
      void offerInstall(
        `OmniDiff: '${resolved.command}' was not found on PATH. The extension needs the omnidiff CLI.`
      );
    } else if (resolved.source === 'setting') {
      void vscode.window.showErrorMessage(
        `OmniDiff: the omnidiff.binaryPath setting points at '${resolved.command}', which could not be run.`
      );
    } else {
      void vscode.window.showErrorMessage(
        'OmniDiff: the bundled omnidiff binary could not be run. Reinstall the extension, or set omnidiff.binaryPath.'
      );
    }
  });
}

export function deactivate(): void {
  // Nothing to do: every decoration type is on `context.subscriptions` and VS Code disposes them.
  // Scratch files are swept by age at the next activation - see `sweepScratch`.
}
