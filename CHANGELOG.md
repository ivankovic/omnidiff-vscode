# Changelog

Notable changes to the OmniDiff extension (published as CodeDiff, `ivankovic.codediff`, up to
0.0.1). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes to the `omnidiff` CLI itself live in
[its own repository](https://github.com/ivankovic/omnidiff); this file covers the extension.

## [0.1.0] - 2026-10-01

### Changed

- **Renamed from CodeDiff to OmniDiff**, following the CLI (v0.2.0). This is a new extension,
  `ivankovic.omnidiff`; the commands, settings and colour IDs are `omnidiff.*`. On first activation,
  any `codediff.*` setting is copied to its `omnidiff.*` counterpart where that one is unset. The
  bundled binary is `omnidiff` v0.2.0, and a `PATH` lookup looks for `omnidiff`.

## [0.0.1] - 2026-09-17

The first published release. Nothing below is a change from an earlier version, because there is
no earlier published version - it is what the extension does the day it reaches the Marketplace
and Open VSX.

### Added

- Syntax-aware highlighting of two files, painted onto real editors as decorations: insert, delete,
  update and move, with a "moved to line N" hover and the nearest enclosing declaration.
- `CodeDiff: Diff Two Files…`, `Diff With HEAD`, `Diff With Revision…`, `Diff With Last Saved` and
  `Clear Highlights`, the git-aware three also on the Source Control and editor-tab context menus.
- Platform-specific builds that bundle the `codediff` binary (v0.0.14) for Linux, macOS and
  Windows x64, falling back to a `PATH` lookup everywhere else. This removes one failure in particular: a VS Code
  launched from Finder or the Dock does not inherit a login shell's `PATH`, so a binary installed to
  `~/.cargo/bin` is invisible to it.
- A prompt with an install link when no binary can be found at all.
- `codediff.renderMode: custom` and six `codediff.render.*` options — the same six the terminal UI
  offers under its `M` panel, so both front ends can be made to paint alike. They take effect
  through codediff's `CODEDIFF_CONFIG`, the one config layer that outranks a project's own
  `.codediff.toml`.
- Its own registered colour IDs - `codediff.insertBackground`, `codediff.deleteBackground`,
  `codediff.updateBackground`, `codediff.moveBackground` - so any one highlight can be retuned,
  per theme if wanted, without repainting anything else in the editor.

### Fixed

- Columns on lines containing non-ASCII characters. codediff reports byte offsets and VS Code's
  `Position.character` is UTF-16 code units; they agree exactly while a line is all-ASCII and
  diverge the moment it is not.
- Two files sharing a basename at one revision no longer overwrite each other's materialised blob,
  which used to reload an open editor with the other file's content.
- `git show` output is read as a `Buffer`, so a file that is not UTF-8 is not corrupted on its way
  to disk.
- codediff's configuration is resolved from the directory of the file being diffed rather than from
  the extension host's inherited working directory, so `renderMode: default` no longer paints
  differently depending on where VS Code was started from.
