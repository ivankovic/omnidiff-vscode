# Contributing to OmniDiff for VS Code

This extension is a thin client. It shells out to the
[omnidiff](https://github.com/ivankovic/omnidiff) binary and paints what comes back; every
interesting decision about *what* a diff says lives in that repository. A bug about a diff being
wrong belongs there. A bug about a highlight landing in the wrong place, a command misbehaving, or
an error message being unhelpful belongs here.

## Getting started

```sh
npm ci
npm run compile        # or: npm run watch
npm run lint
npm test
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the extension loaded.
You need an `omnidiff` binary on `PATH` to do anything useful in it.

## The three checks CI gates on

```sh
npx tsc -p ./ --noEmit   # types
npm run lint             # eslint
npm test                 # compile + node --test
```

CI additionally runs `vsce package`, which catches a broken manifest or a `.vscodeignore` that
excludes something the extension needs — neither of which the other three can see.

`make check` runs all four in that order, and is what `make deploy` gates on. The `vsce` half
needs Node 22; see [Releasing](#releasing).

## Architecture, and why it is split this way

| File | Imports `vscode`? | Why |
| --- | --- | --- |
| `src/columns.ts` | no | Imports **nothing**. Byte → UTF-16 conversion. |
| `src/omnidiff.ts` | no | Spawning and JSON validation. |
| `src/git.ts` | no | `rev-parse` / `git show`, and writing a blob out under its real basename. |
| `src/binary.ts` | no | Which `omnidiff` to run: setting → bundled → `PATH`. |
| `src/decorations.ts` | yes | Hunks → `TextEditorDecorationType`. |
| `src/extension.ts` | yes | Commands and editor glue. |

The split is not decoration. Testing a VS Code extension normally means downloading a whole VS Code
and running an editor host, which is slow enough that people stop doing it. Keeping the two modules
that carry the real logic free of `vscode` means their tests run under plain `node --test` in under
a second — so they run on every commit, and on every Node version the extension host might use.

**Keep new logic out of the two `vscode`-importing files** wherever it can go elsewhere. If
something needs an editor, the usual answer is a pure function next door that takes the data it
needs, plus three lines in `extension.ts` that fetch it.

## Tests

`src/test/columns.test.ts` is the one to be careful with. omnidiff reports **byte** columns; VS
Code wants **UTF-16 code units**. They are identical on any all-ASCII line, so a broken conversion
passes every casual test and then mis-highlights every line containing an accent, an ideograph or
an emoji. The suite covers two-byte, three-byte and astral characters, out-of-range clamping,
mid-character rounding, and a per-byte-offset agreement check against `Buffer.byteLength` across a
mixed line. Do not delete those for being slow — the whole file runs in milliseconds.

**Running it drops a `.omnidiff.toml` in this checkout.** omnidiff stores its settings in a
dotfile in whatever directory it runs in — there is no user-level config yet — so any invocation
from here leaves one behind. It is in `.gitignore` and `.vscodeignore`; delete it freely, and do
not commit it.

`src/test/git.test.ts` builds a real throwaway repository in a temp directory and, unlike the
integration test below, does **not** skip when its dependency is missing: git is a hard requirement
of the commands it covers, so a machine without it should fail here rather than quietly pass. Two of
its cases exist for reasons that are easy to undo by accident — `git show` output is read as a
`Buffer` because decoding it as UTF-8 corrupts any file that is not UTF-8, and the materialised file
keeps its original basename because omnidiff's language detection reads the path.

`src/test/integration.test.ts` runs the real binary and **skips itself when omnidiff is not on
`PATH`**, which includes CI. It is a local-development check, not a gate: installing omnidiff in CI
would add minutes of Rust compilation to every run for one assertion the unit tests already cover
apart from the spawn. Run it locally before touching anything about spawning or JSON handling.

## Style

* Every source file carries the AGPL header. Copy it from an existing file when adding one.
* Comments explain *why*, not *what*. The main omnidiff repository's
  [`CONTRIBUTING.md`](https://github.com/ivankovic/omnidiff/blob/main/CONTRIBUTING.md) sets the
  house style and it applies here too.
* No `any`, and no `as SomeType` to silence the compiler on data that came from outside the
  process. `parseDiff` validates omnidiff's output at the boundary precisely so that nothing
  downstream has to guess.

## Bundling the binary

`scripts/fetch-binary.mjs <vsce-target>` downloads the omnidiff release pinned by
`omnidiffVersion` in package.json into `bin/`, verifying it against that release's
`SHA256SUMS.txt`. `bin/` is gitignored — it is a build input, not source.

Two things here are easy to get wrong and are checked rather than assumed:

* **The execute bit.** A VSIX is a ZIP, and ZIP carries Unix mode bits only if the writer sets
  them; `vsce` does not reliably. A binary that lands without `+x` fails at spawn with `EACCES` on
  the user's machine long after CI was green. `ensureExecutable` chmods at activation *and*
  `release.yml` reads the mode back out of the packaged VSIX — the first masks a broken package,
  only the second proves a good one.
* **VS Code's target names are not Rust triples.** `linux-x64` ↔ `x86_64-unknown-linux-gnu`, and so
  on. The mapping lives in `scripts/fetch-binary.mjs`; a test asserts the release workflow's matrix
  and that table list the same targets, because a target in one but not the other either fails the
  build or silently stops publishing a platform.

`omnidiffVersion` in `package.json` is the pin, and moving it is a deliberate, separate release of
this extension: a platform build ships a frozen CLI, so nobody gets a newer omnidiff until that
happens. A release is only usable as a pin if it carries a `SHA256SUMS.txt` and all five archives,
`aarch64-unknown-linux-gnu` among them — omnidiff's release workflow gained both in v0.0.13, so
anything older 404s, which is the designed failure rather than quietly producing a VSIX with no
binary.

CI builds only the binary-free fallback VSIX, so a pull request never depends on a published tag of
another repository. The five platform VSIXs are built in `release.yml`, on a tag.

**The jobs that run `vsce` are pinned to Node 22, not the 20 the rest of CI uses**, because
`@vscode/vsce` declares `engines: node >= 22`. npm only warns about an engine mismatch, so those
jobs ran on 20 and worked by luck: vsce 4 calls `util.styleText`, which recent 20.x happens to
carry and 18 does not.

The test matrix is [18, 20, 22] — the extension host's Node, which is a different question from the
packaging tool's, but which now has to include 22 for a reason of its own: `node --test <directory>`
means "run that path as a file" there, not "every test file under it". `npm test` names the files
with a glob instead. On a [18, 20] matrix that break was invisible, and it is the failure mode to
expect from the test runner generally — it is the one part of Node that is still changing shape.

## The icon

`icon.png` is generated: `python3 assets/icon.py` redraws it. Recolouring or resizing it is an edit
to that script, not to a binary, and the reasoning behind the design — including which richer
pictures were tried and discarded for being illegible at 32px — is in its docstring.

## Releasing

`make deploy` is the whole of it. It refuses a dirty tree, refuses a HEAD that does not match
`origin/main`, refuses a version that is already tagged or that `CHANGELOG.md` has no section for,
runs the four gates, and then tags `v<version>` and pushes the tag. It publishes nothing itself.

The tag is what starts a release. `release.yml` builds the five platform VSIXs and the target-less
fallback, attaches all six to a GitHub Release, and publishes those same six files to the
Marketplace and to Open VSX.

**Publishing the files CI built, rather than repackaging, is the point of that split.** The two
checks that matter — the execute bit surviving into the archive, and the fallback carrying no
binary — only ever ran on CI's artefacts, so those are the artefacts that should reach users.

The version number is the one irreversible part. A Marketplace version can never be republished or
reused, only superseded, which is why `deploy-checks` would rather fail on a missing changelog
section than let a number through.

### Credentials, once

The two registries authenticate differently, and only Open VSX uses a token.

**The Marketplace — Microsoft Entra ID, no token.** Azure DevOps retires *global* personal access
tokens on **2026-12-01**, and a global PAT — the "All accessible organizations" kind — is the only
sort the Marketplace has ever accepted. Organization-scoped tokens are not accepted for publishing;
[microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741) is the open request to
change that. So the PAT route has an expiry date on it and is not worth setting up. Entra with
workload identity federation is what replaces it, and it stores no secret at all: `azure/login`
trades the workflow's own OIDC token for a short-lived one at run time.

The whole Azure side is `az`, which on Ubuntu is `sudo apt-get install azure-cli` from Microsoft's
repository — see their [install page](https://learn.microsoft.com/cli/azure/install-azure-cli-linux).

1. A **user-assigned managed identity**. Not an app registration — those authenticate fine and then
   fail at publish with `InvalidAccessException: The requested operation is not allowed`.

   ```sh
   az login
   az group create --name omnidiff-publish --location westeurope
   az identity create --name omnidiff-marketplace --resource-group omnidiff-publish \
     --query '{clientId:clientId, tenantId:tenantId}' -o table
   ```

2. A federated credential on it, trusting this repository's `marketplace-publish` environment.
   Entra matches the subject as an exact string, and there are two ways to get it wrong.

   **Environment, not branch or tag** — that is the part of the subject the jobs control, by
   declaring `environment: marketplace-publish`.

   **The owner and repository carry their numeric ids.** Every repository created after
   2026-07-15 gets GitHub's *immutable* subject format, which appends the owner id and repo id so
   that a rename or a recycled name cannot mint a matching token. A subject written from the names
   alone is rejected with `AADSTS700213: No matching federated identity record found`. Read the
   ids off the API rather than typing them:

   ```sh
   owner=$(curl -sS https://api.github.com/users/ivankovic | jq -r .id)
   repo=$(curl -sS https://api.github.com/repos/ivankovic/omnidiff-vscode | jq -r .id)

   az identity federated-credential create \
     --name github-marketplace-publish \
     --identity-name omnidiff-marketplace --resource-group omnidiff-publish \
     --issuer https://token.actions.githubusercontent.com \
     --subject "repo:ivankovic@$owner/omnidiff-vscode@$repo:environment:marketplace-publish" \
     --audiences api://AzureADTokenExchange
   ```

   If it is already wrong, the failing run prints the subject it actually presented — copy that
   verbatim into `az identity federated-credential update --subject`.

   The names above are for a fresh setup. The identity this repository publishes with was created
   before the rename to OmniDiff and kept its names, because renaming it would change its client
   id; `az identity list -o table` shows them. The rename did change the repository name in the
   subject, so the credential was updated to `omnidiff-vscode` on 2026-10-01.

3. The GitHub side: an environment named `marketplace-publish`
   (<https://github.com/ivankovic/omnidiff-vscode/settings/environments>, no protection rules
   needed), and the Client ID and Tenant ID as the `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`
   repository secrets. They are identifiers rather than credentials, but each job checks both are
   non-empty first, because an unset one is an empty string and fails later inside an OIDC exchange
   whose error names nothing useful.

4. **Add the identity to an Azure DevOps organization.** Entra removes the PAT, not the
   organization. A service principal does not appear in Azure DevOps on its own — Microsoft calls
   this *materialization*, and it has to be explicit, because a service principal cannot sign in
   interactively the way a person can. Until it is done, every Azure DevOps call answers
   `VSS011031: There is no profile for the authenticated user in the system`.

   **Creating the organization is the one step with no CLI.** `az devops` manages projects,
   teams and pipelines inside an organization; it has no command that makes one. Create it at
   <https://aex.dev.azure.com> — any name, it holds no code and no pipelines. It has to be
   connected to the same tenant the identity lives in, which one created while signed in as
   yourself will be.

   Adding the identity *is* scriptable, through the ServicePrincipalEntitlements API. Note
   `originId`: it is the identity's **principalId**, the service principal's object id, not its
   client id — the two are easy to confuse and the wrong one fails as "not found".

   ```sh
   org=<the organization name>
   principal=$(az identity show --name omnidiff-marketplace \
     --resource-group omnidiff-publish --query principalId -o tsv)

   az rest --method post \
     --resource 499b84ac-1321-427f-aa17-267ca6975798 \
     --url "https://vsaex.dev.azure.com/$org/_apis/serviceprincipalentitlements?api-version=7.1-preview.1" \
     --headers Content-Type=application/json \
     --body "{
       \"accessLevel\": {\"accountLicenseType\": \"stakeholder\"},
       \"servicePrincipal\": {
         \"origin\": \"aad\",
         \"originId\": \"$principal\",
         \"subjectKind\": \"servicePrincipal\"
       }
     }"
   ```

   `stakeholder` is the free access level and is what Microsoft's own example uses. If a later
   publish fails on licensing, `express` is Basic, free for the first five identities in an
   organization.

   That call can fail on *the caller* rather than on the identity being added: `Identity <guid>
   has not been materialized, please use interactive login over the browser first`, where the
   guid is your own user. Materialization applies to people too — an Entra token for a user
   Azure DevOps has never seen is refused. Check whether the guid is yours with
   `az ad signed-in-user show --query id`; if it is, do this step in the portal instead
   (**Organization Settings → Users → Add users**, entering the identity's *display name*,
   `omnidiff-marketplace`), where the browser session is an identity the organization already
   knows.

   Also confirm under **Organization Settings → Microsoft Entra** that the organization is
   connected to the same tenant as the identity. An organization created with a personal
   Microsoft account is not backed by a directory, and a managed identity cannot be added to it
   at all — identities can only come from the tenant the organization is connected to.

5. **Read the identity's Azure DevOps profile id**, by running the **Entra identity id** workflow
   (`.github/workflows/entra-identity-id.yml`) from the Actions tab. It prints an id to the run
   summary.

   This cannot be done from a laptop. A user-assigned managed identity has no secret to sign in
   with — `az login --identity` reaches the instance metadata endpoint, which exists only inside
   Azure — so the one thing that can authenticate as it is a job holding an OIDC token the
   federated credential trusts. A green run also proves steps 2, 3 and 4 all line up, before a
   release depends on it.

   **Keep that id.** It is the only identifier the publisher's member search recognises; the Client
   ID, the Tenant ID and the resource ID all come back empty.

6. A publisher at <https://marketplace.visualstudio.com/manage> whose ID is `ivankovic`, matching
   `publisher` in `package.json` (the ID cannot be changed afterwards), then add that id as a
   member with the **Contributor** role.

**`OVSX_PAT`** — Open VSX, which is what VSCodium, Cursor and Windsurf install from:

1. An Eclipse Foundation account, with the publisher agreement signed.
2. A token from <https://open-vsx.org/user-settings/tokens>, added as the `OVSX_PAT` secret.
3. The namespace is created by the workflow itself — `ovsx create-namespace ivankovic` runs on
   every release and is expected to fail after the first.

### Doing it by hand

If a publish job fails and you would rather finish it locally, publish the artefacts from the
GitHub Release rather than building new ones:

```sh
az login                                  # as the identity, or as yourself if you are a publisher member
vsce publish --skip-duplicate --azure-credential --packagePath *.vsix
ovsx publish --skip-duplicate --packagePath *.vsix -p "$OVSX_PAT"
```

`--packagePath` is variadic — one flag, many paths — which is how the six builds land as one
version. `--skip-duplicate` steps over whatever the failed job already published; it is safe here
precisely because nothing else can make this command run twice on one version.
`--azure-credential` is what makes `vsce` read the Entra token `az login` left behind rather than
look for a `VSCE_PAT` that no longer exists.

If a publish got far enough to be *partly* wrong rather than partly done — a bad README, the wrong
binary in a target — the answer is a new version, not a retry. A Marketplace version can be
superseded and never replaced, and `deploy-checks` cannot see that: it knows about local tags, not
about what is live.

`make package-all` reproduces all six locally when a build job is the thing that broke. It needs
Node 22 — as does anything running `vsce` — and it deletes `bin/` afterwards, because a stale
`bin/` is how a glibc binary ends up inside the fallback VSIX that musl users are served.

## Licence

By contributing you agree that your contributions are licensed under AGPL-3.0-or-later, the same
licence as [`LICENSE`](LICENSE) and as omnidiff itself.
