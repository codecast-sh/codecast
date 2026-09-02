# Release pipeline templates

Copy this directory into the CLI package of the product (`packages/cli/scripts`
plus `packages/cli/npm`, or wherever the product keeps scripts), fill in
`release.env` from `release.env.example`, and rename the handful of literals
listed per file. The scripts are the parameterized form of codecast's
`packages/cli/scripts/build-binaries.sh`, `deploy.sh`, `make-formula.sh`, the
`npm/` shim and the two GitHub workflows.

One release, in order:

1. Gate: typecheck and tests must pass (the product's deploy script owns this).
2. `build-binaries.sh`: bun compiles five targets (darwin arm64 and x64, linux
   arm64 and x64, windows x64) and signs the macOS ones with a stable Developer
   ID identity so TCC grants survive self updates.
3. `upload-binaries.sh <version>`: uploads to R2, writes `latest.json` with a
   sha256 per platform (the manifest `@platform/cli-kit`'s updater reads),
   syncs the npm shim's `package.json` version and `checksums.json`, and warms
   the CDN before anyone is forced to download.
4. The product flips the minimum version (`min_cli_version`) when it wants the
   fleet to converge now; otherwise clients notice on their next poll.
5. `publish-mirrors.sh <version>`: GitHub release, npm, Homebrew tap. All non
   fatal: R2 plus the minimum version is the release, these are mirrors that
   install the GitHub release assets and verify them against the same checksums.

## What to rename

- `release.env`: every value. `BINARY_NAME` is the asset prefix and the binary
  file name; `ALIAS_NAME` is the optional short command; `RELEASE_BASE_URL` is
  the public origin (codecast: `https://dl.codecast.sh`).
- `npm/package.json`: `name`, `bin` keys, `repository`, `homepage`.
  `npm/install.js`: `REPO`, `BINARY_NAME`. `npm/bin/launcher.js`:
  `BINARY_NAME`. Rename `launcher.js` to the product name if you like.
- `workflows/*.yml`: the `env` block at the top (`R2_BUCKET`, `BINARY_NAME`,
  `CLI_DIR`, `RELEASE_BASE_URL`), the bun version, and the shared package paths
  in the "build inputs changed" diff (`packages/shared` in codecast). The
  secrets they expect: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`.

## The two workflows

`accelerate-cli-staging.yml` rebuilds the non macOS binaries on two macOS
runners at the exact source commit and uploads only byte identical results to
the staging objects, so a slow upload from the builder machine can be overtaken.
It never writes `latest.json` or the minimum version.

`finalize-cli-release.yml` is the release gate. It waits for all five staging
objects to be newer than `uploaded_after` with the expected sizes, downloads and
verifies each against the builder manifest (hash, size, `file` kind, and
`--version` output of the linux binary), stages immutable copies under
`cli/releases/v<version>/<commit>` with immutable cache headers, verifies the
public bytes, pushes the version bump commit and the tag atomically, creates or
verifies the GitHub release (asset digests), refreshes the stable aliases with
`no-cache`, and publishes `latest.json` last, then re-reads it from the public
URL until it matches byte for byte.

Both take the builder manifest as input:

```json
{ "version": "1.2.3", "source_commit": "<40 hex>", "built": "<iso>",
  "artifacts": { "acme-darwin-arm64": { "sha256": "<hex>", "size": 12345678 }, "...": {} } }
```

## Formats

`latest.json` (what the updater reads):

```json
{ "version": "1.2.3", "released": "2026-01-01T00:00:00Z", "sourceCommit": "<optional>",
  "binaries": { "darwin-arm64": { "url": "https://dl.example.com/acme-darwin-arm64", "sha256": "<hex>" } } }
```

`checksums.json` (npm shim and Homebrew formula): `{ "<platform-key>": "<sha256>" }`
for the five keys `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`windows-x64`. Windows on ARM runs the x64 build under emulation.

Channels: the updater reads one manifest per channel (`stable` reads
`latest.json`; a `beta` channel would read `latest-beta.json`). To add a
channel, run `upload-binaries.sh` with the manifest name changed and register
the channel in the product's `Updater` config. Codecast ships one channel.
