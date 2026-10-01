# OmniDiff for VS Code

[![CI](https://github.com/ivankovic/omnidiff-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/ivankovic/omnidiff-vscode/actions/workflows/ci.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Syntax-aware diff highlighting in VS Code, backed by the
[omnidiff](https://github.com/ivankovic/omnidiff) CLI.

Instead of aligning two files line by line, omnidiff parses both sides with tree-sitter and matches
their syntax trees, so a change is reported as what it structurally is — an **insertion**,
**deletion**, **update**, or **move** — rather than as whichever lines happened to line up. This
extension paints that verdict onto real editors as decorations.

## Status

Early, but complete enough to use. Everything below the editor — spawning omnidiff, parsing its
output, converting its byte columns, reading blobs out of git — is covered by tests that run in CI.
The editor glue itself (decorations, menus, prompts) has no automated coverage, because none of it
can run outside a VS Code host; treat those parts as reviewed rather than proven.

| | |
| --- | --- |
| Diff two files from disk | ✅ works |
| Insert / delete / update / move highlighting | ✅ works |
| "Moved to line N" on hover | ✅ works |
| Correct columns on non-ASCII lines | ✅ works, and tested |
| Diffing against a git revision, from the SCM view | ✅ works |
| Diffing the working copy against the last save | ✅ works |
| Install prompt when the binary is missing | ✅ works |
| Bundled binary, per platform | ✅ works — see [Requirements](#requirements) |

## Installing

Search for **OmniDiff** in the Extensions view, or:

* VS Code — [the Marketplace listing](https://marketplace.visualstudio.com/items?itemName=ivankovic.omnidiff),
  or `code --install-extension ivankovic.omnidiff`.
* VSCodium, Cursor, Windsurf and other non-Microsoft builds —
  [Open VSX](https://open-vsx.org/extension/ivankovic/omnidiff), which those editors search by
  default.
* Any editor, offline — download a `.vsix` from
  [the releases page](https://github.com/ivankovic/omnidiff-vscode/releases) and install it with
  `code --install-extension omnidiff-<platform>.vsix`. Take the one matching your platform to get
  the bundled binary, or `omnidiff-fallback.vsix` to use an `omnidiff` from `PATH`.

## Requirements

The `omnidiff` binary. Platform-specific builds of this extension **bundle it**, so on those there
is nothing to install:

| Platform | Bundled? |
| --- | --- |
| Linux x64 / arm64 | ✅ |
| macOS Intel / Apple silicon | ✅ |
| Windows x64 | ✅ |
| Everything else — Windows on ARM, Alpine/musl containers | ❌ falls back to `PATH` |

Alpine is deliberately unbundled: a `linux-x64` build carries a glibc binary that dies on musl with
an unreadable loader error, so those users get the binary-free fallback build and the `PATH` lookup
instead.

**Which binary gets run**, in order:

1. `omnidiff.binaryPath`, if you have set it to anything other than the default. It wins
   unconditionally, so point it at your own build to use that.
2. The bundled binary, if this build carries one.
3. `omnidiff` on `PATH`.

Step 2 exists for one failure in particular: a VS Code launched from Finder or the Dock does not
inherit a login shell's `PATH`, so an `omnidiff` installed to `~/.cargo/bin` is invisible to it and
the extension reports a missing binary you can plainly run in a terminal.

If you need to install it yourself, see
[omnidiff's installation instructions](https://github.com/ivankovic/omnidiff#installation) —
`cargo install omnidiff`, a pre-built binary from a release, `nix run github:ivankovic/omnidiff`, or
one of the distribution packages.

## Usage

| Command | What it diffs |
| --- | --- |
| `OmniDiff: Diff Two Files…` | Two files you pick. |
| `OmniDiff: Diff With HEAD` | The committed version against your working copy. |
| `OmniDiff: Diff With Revision…` | Any ref `git show` accepts — a branch, a tag, `HEAD~3` — against your working copy. |
| `OmniDiff: Diff With Last Saved` | What is on disk against what you have typed but not saved. |
| `OmniDiff: Clear Highlights` | Removes the painting from every visible editor. |

The three git-aware commands are also on the right-click menu of a file in the **Source Control**
view and of an editor tab. In every one of them the left pane is the *before* side, matching
`omnidiff.nvim`'s `diff_this`.

Files pulled out of git are written to the extension's own storage directory under their real
basename — `HEAD/parser.ts`, not a scratch name — because omnidiff picks a tree-sitter grammar from
the path. A blob written to a nameless temp file gets no grammar and silently falls back to a plain
line diff. They are swept a day later, at the next activation.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `omnidiff.binaryPath` | `omnidiff` | Path to, or name of, the binary. Looked up on `PATH` when it is a bare name. |
| `omnidiff.renderMode` | `default` | Which ranges get painted: `default`, `minimal`, `full`, or `custom`. |

`renderMode` is the one that decides how much you see:

- **`default`** defers to omnidiff's own config — the nearest `.omnidiff.toml` at or above **the
  directory of the file you are diffing**, else your user-level one. A project can pin its own
  render options this way, and the same two files then paint the same way however VS Code was
  launched.
- **`minimal`** and **`full`** pass `--minimal`/`--full`, the two presets, overriding that config.
- **`custom`** uses the six options below and ignores omnidiff's config entirely.

### The six painting options

These are the whole of what omnidiff's terminal UI offers under its `M` panel, and they apply
**only when `omnidiff.renderMode` is `custom`** — VS Code has no way to grey out a setting that
does not currently apply, so changing one while the mode is anything else does nothing and says
nothing.

| Setting | Default | What turning it on does |
| --- | --- | --- |
| `omnidiff.render.leadingWhitespace` | `true` | Keeps the whitespace a range starts with, on every line of it. |
| `omnidiff.render.structuralPunctuation` | `true` | Paints ranges that are only brackets and separators. Operators are never dropped — `<` to `<=` is the whole edit. |
| `omnidiff.render.wholePairUpdates` | `false` | Highlights an updated pair whole rather than just the part that differs. |
| `omnidiff.render.paintReindentOnlyMoves` | `true` | Calls a pure reindent a move. |
| `omnidiff.render.paintDisplacedMoves` | `true` | Calls a node pushed along by a neighbouring edit a move. |
| `omnidiff.render.paintResizedMoves` | `true` | Reports moves whose two sides are different sizes. |

The defaults are omnidiff's own, which are its `full` preset — note that is not all six on, because
`wholePairUpdates` is off in both presets. It changes which ranges the diff *has* rather than how
much of a decided range is painted, so it sits on a different axis. Switching to `custom` therefore
changes nothing until you toggle something.

The terminal UI's other settings have no counterpart here on purpose: its theme and custom palette
are replaced by the [colour IDs](#colours) below, which follow your VS Code theme, and its panel
layout and node highlight describe a terminal UI this extension does not have — VS Code owns the
panes.

Under the hood `custom` writes a small config file into the extension's storage and points
omnidiff's `OMNIDIFF_CONFIG` at it, which is the one layer that outranks every `.omnidiff.toml`.
That is why `custom` ignores a project's config where `default` respects it.

## Colours

Each highlight has its own registered colour ID, so you can retune one without touching anything
else in the editor:

| Operation | Colour ID | Default on dark | Composited on `#1e1e1e` |
| --- | --- | --- | --- |
| insert | `omnidiff.insertBackground` | `#32d74bb3` | `#2ca03e` |
| delete | `omnidiff.deleteBackground` | `#ff3b30b3` | `#bc322b` |
| update | `omnidiff.updateBackground` | `#ff8c1ab3` | `#bc6b1b` |
| move | `omnidiff.moveBackground` | `#5c5d64cc` | `#505056` |

All four are literals, at 70% alpha on dark. None of them references a theme key, and insert and
delete are the interesting case: `diffEditor.insertedTextBackground` and
`diffEditor.removedTextBackground` are the obvious references, and this extension used them, but
both sit at 20% alpha — right for the diff editor, which washes whole lines with colour, and far
too faint here, where what gets painted is often a single identifier. Update is an orange rather
than the olive it started as so that it cannot read as a dimmer insert.

Alpha rather than opaque colour, so each still composites over the theme's own editor background.
`contributes.colors` takes one value per theme *kind* — light, dark, high-contrast — not per theme,
so a single dark value has to serve every dark theme. If one of them sits badly in yours, override
it, scoped to that theme if you like:

```jsonc
"workbench.colorCustomizations": {
  "omnidiff.moveBackground": "#5c5d64",
  "[Solarized Light]": { "omnidiff.moveBackground": "#d8d3c0" }
}
```

That is the reason these are contributed IDs rather than direct references to shared keys:
retuning `editor.symbolHighlightBackground` would repaint find-match highlights across the whole
editor, while `omnidiff.moveBackground` touches nothing but this extension.

## How it works

`omnidiff --mode json BEFORE AFTER` prints one JSON object describing each side's changed ranges,
their operation, a move's real counterpart range in the other file, and the nearest enclosing
declaration. This extension parses that and calls `setDecorations`; it never parses ANSI escapes
out of a terminal diff tool.

**omnidiff reports columns as byte offsets. VS Code's `Position.character` is UTF-16 code units.**
They agree exactly while a line is all-ASCII and diverge the moment it is not — which is what makes
this the easiest thing in the whole integration to get wrong. Measured against the real binary: for
the line `x = "ααα" + bbb`, omnidiff reports column 15 where VS Code needs 12. `src/columns.ts`
does the conversion, and `src/test/columns.test.ts` pins it against `Buffer.byteLength` at every
byte offset of a mixed ASCII/Latin-1/CJK/emoji line.

(Neovim needs no such conversion — `nvim_buf_set_extmark` takes byte columns directly — which is
why omnidiff emits bytes rather than a second coordinate space it could disagree with itself about.
See [omnidiff.nvim](https://github.com/ivankovic/omnidiff.nvim).)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm ci`, then `npm run lint` and `npm test`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE), the same licence as
[omnidiff](https://github.com/ivankovic/omnidiff) itself.
