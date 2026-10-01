# Everything a release needs, in the order a release needs it. Deliberately thin: the checks are
# the same three npm scripts CI runs, and the packaging is the same `vsce` invocation - this file
# exists so that `make deploy` is one command with the guards attached, not so that there is a
# second way to build.
#
# The division of labour with .github/workflows/release.yml is the same one the omnidiff
# repository uses:
#
#   make deploy   runs the gates locally, then tags and pushes. It publishes nothing itself.
#   release.yml   sees the tag, builds the six VSIXs, attaches them to a GitHub Release, and
#                 publishes those exact files to the Marketplace and Open VSX.
#
# Publishing the artefacts CI built rather than repackaging locally is the point of the split: the
# two checks that matter - the execute bit inside the archive, and the fallback carrying no binary
# - only ever ran on CI's files, so those are the files that should reach users.

.PHONY: install compile lint test check package package-all clean deploy-checks deploy

VSCE := npx --yes @vscode/vsce

# VS Code's target names, not Rust triples. Kept in step with release.yml's matrix and with
# scripts/fetch-binary.mjs by a test - see CONTRIBUTING.md.
TARGETS := linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64

VERSION := $(shell node -p "require('./package.json').version")

install:
	npm ci

compile:
	npm run compile

lint:
	npm run lint

test:
	npm test

# The four gates CI runs, in the order CI runs them. `package` is here rather than left to CI
# because a broken manifest or an over-eager .vscodeignore is invisible to the other three and
# costs a tag to discover.
check: compile lint test package

# @vscode/vsce declares `engines: node >= 22`, and npm only *warns* on an engine mismatch - so a
# too-old Node gets as far as a confusing crash inside vsce rather than a refusal. The release
# jobs pin Node 22 for the same reason; this is the local half of that guard.
#
# The test matrix stays [18, 20]: that is the extension host's Node, which is a different question
# from the packaging tool's.
define require-node-22
	@node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { \
		echo "error: @vscode/vsce needs Node >= 22, found $$(node --version)" >&2; \
		exit 1; \
	}
endef

# The target-less fallback VSIX, which is what the Marketplace serves to any platform with no
# package of its own.
#
# `rm -rf bin` is load-bearing and is the one thing this target does that CI does not have to:
# CI builds the fallback on a fresh checkout, so `bin/` is never there. A local checkout has one
# the moment anybody runs `npm run fetch-binary`, and .vscodeignore cannot exclude it (it must
# ship in the platform VSIXs). Packaging without this line puts a glibc binary in the build that
# musl and Windows-on-ARM users are served.
package: clean
	$(require-node-22)
	$(VSCE) package --out omnidiff-fallback.vsix
	@if unzip -Z1 omnidiff-fallback.vsix | grep -q '^extension/bin/'; then \
		echo "error: the fallback VSIX contains a bundled binary" >&2; \
		exit 1; \
	fi
	@echo "omnidiff-fallback.vsix: no bundled binary, as intended"

# Every VSIX a release ships, built the way release.yml builds them. Not part of `check` - it
# downloads five ~6MB archives from the pinned omnidiff release - but it is the way to reproduce
# a release job locally when one fails.
# The `trap` is the point of the shell being written this way. A failure partway through - a 404,
# a checksum mismatch - would otherwise leave `bin/` populated with whichever platform's binary got
# that far, and the next bare `vsce package` would put it in the fallback VSIX. `make package`
# cleans first and so self-heals; nothing protects someone who runs vsce directly.
package-all: package
	$(require-node-22)
	@trap 'rm -rf bin' EXIT; \
	for target in $(TARGETS); do \
		echo "=== $$target ==="; \
		npm run fetch-binary -- $$target || exit 1; \
		$(VSCE) package --target $$target --out omnidiff-$$target.vsix || exit 1; \
	done

clean:
	rm -rf bin out *.vsix

# Shared preconditions for `deploy`. A clean tree and HEAD already matching origin/main, so a tag
# cannot point at work nobody else can see; the version agreeing with the changelog, because a
# Marketplace version number can never be reused and the changelog is where its meaning is
# recorded; then the gates.
#
# The version guard is not bureaucracy. `vsce publish` will happily publish 0.0.1 twice from two
# different commits and only the second one fails, hours after the tag - whereas a version whose
# changelog section is still `[Unreleased]` is the normal way to find out you forgot to write one.
deploy-checks:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "error: working tree is dirty - commit or stash before deploying" >&2; \
		exit 1; \
	fi
	git fetch origin main
	@if [ "$$(git rev-parse HEAD)" != "$$(git rev-parse origin/main)" ]; then \
		echo "error: HEAD does not match origin/main - push your commits first" >&2; \
		exit 1; \
	fi
	@if git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null; then \
		echo "error: tag v$(VERSION) already exists - bump the version in package.json" >&2; \
		exit 1; \
	fi
	@if ! grep -q '^## \[$(VERSION)\]' CHANGELOG.md; then \
		echo "error: CHANGELOG.md has no '## [$(VERSION)]' section" >&2; \
		exit 1; \
	fi
	$(MAKE) check

# Tags the current commit as v<package.json version> and pushes the tag, which is the only thing
# that starts a release. Everything public-facing happens in release.yml from here.
deploy: deploy-checks
	@echo "Tagging and pushing v$(VERSION)..."
	git tag v$(VERSION)
	git push origin v$(VERSION)
	@echo
	@echo "Pushed v$(VERSION). release.yml now builds the six VSIXs, attaches them to a GitHub"
	@echo "Release, and publishes them. Watch:"
	@echo "  https://github.com/ivankovic/omnidiff-vscode/actions/workflows/release.yml"
