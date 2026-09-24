# Release manifest signing

How a CLI in the field decides that `latest.json` is ours, and the order in
which that decision becomes enforceable without stranding any client.

## What is verified today

Every client, whatever its version, reads `https://dl.codecast.sh/latest.json`,
downloads the binary the manifest names for its platform, checks the SHA-256
the manifest gives, and swaps the executable. The hash proves the bytes match
what the manifest says. It does not prove the manifest is ours: the hash comes
from the same host as the bytes, so whoever can change the manifest can change
the hash beside it.

Since 2026-09-23 the canonical updater (`~/src/platform/packages/cli-kit/src/update`)
adds these checks before a download starts, and they apply to every client that
ships this code:

- the binary URL is https, on the release origin, with a plain asset path (no
  query, fragment, credentials, percent escapes or shell characters);
- the digest is a bare 64 character hex string;
- a declared size is inside the bound (512 MiB), and the downloaded file is too;
- redirects stay on the release origin and https, at most three hops;
- the download runs through `curl` with argv, never a shell line;
- on darwin, a client that is itself signed by team `WRG9THCK9Q` refuses a new
  binary that is unsigned, invalid or signed by another team; an unsigned or
  dev client keeps updating as before;
- the swap keeps the old binary until the new one is in place and restores it
  if the rename fails part way.

The installer (`packages/web/public/install.sh`) reads the manifest, takes the
binary URL only from `dl.codecast.sh`, and verifies the SHA-256 before the file
lands in PATH.

## The signature

The publisher signs the exact bytes of `latest.json` with an Ed25519 key and
uploads the detached signature as `latest.json.sig`:

```json
{ "signatures": [ { "keyId": "cli-release-2026", "alg": "ed25519", "sig": "<base64>" } ] }
```

The client pins public keys by key id in `RELEASE_MANIFEST_SIGNING`
(`packages/cli/src/update.ts`). The verification lives in
`cli-kit/src/update/signing.ts`; the publisher side is
`cli-kit/release/sign-manifest.ts` (`--keygen`, sign, `--append`, `--verify`).

Policy, per client build:

| policy | no `.sig` | signed by a pinned key | pinned key, bad signature | signed only by unknown keys |
|---|---|---|---|---|
| no keys pinned (today) | accept, no request made | n/a | n/a | n/a |
| keys pinned, `required: false` | accept | accept, verified | refuse | accept |
| keys pinned, `required: true` | refuse | accept, verified | refuse | refuse |

A bad signature by a pinned key is refused under every policy: it is evidence
the manifest changed after signing, never "unsigned".

Anti-rollback: a client records the `released` stamp of the newest manifest a
pinned key vouched for and refuses a later verified manifest with an older
stamp. The finalize workflow stamps every publish, including a recovery to an
older version, with a fresh `released`, so legitimate recovery is never
refused. Unsigned manifests carry no such promise and are not checked.

## Rollout order

The invariant: a client is never asked to verify something the publisher does
not yet produce, and the publisher never stops producing what a client in the
field still accepts.

1. **Ship the verification code with no key pinned.** This is the state of
   the tree today. Behaviour is byte for byte what the fleet does now: no
   signature request, no new refusal. Old clients keep updating.
2. **Create the key** (a product decision, see below). Store the private PEM
   as the repository secret `RELEASE_MANIFEST_SIGNING_KEY` and the key id as
   `RELEASE_MANIFEST_KEY_ID`. The finalize workflow starts signing every
   `latest.json` it publishes and uploads `latest.json.sig` beside it. Clients
   in the field ignore the file.
3. **Pin the public key** in `RELEASE_MANIFEST_SIGNING.keys` with
   `required: false` and release. New clients verify when the file is there
   and refuse a forged signature; a missing file is still accepted, so a
   client updated before step 2 shipped, or a release from a path that does
   not sign, still works.
4. **Wait for the fleet.** Raise `min_cli_version` to the step 3 release once
   the daemon heartbeat shows the field has moved; a client below the floor
   updates itself.
5. **Flip `required: true`** and release. From here a manifest without a
   signature by a pinned key is refused. This is the first step that can
   strand a client, so it happens only after step 4.

Rotation: generate the new key, pin it beside the old one (`keys` holds both),
release, wait for the fleet, then sign with both (`--append`) and finally drop
the old key from the pipeline and from `keys`. A client that knows either key
accepts a manifest signed by both.

Emergency recovery (a key is lost or leaked): while `required` is `false`,
remove the compromised key from the pipeline and publish unsigned; clients
accept it, which is the reason step 5 waits. Once `required` is `true`, the
recovery path is a new release with the replacement key pinned, force-updated
through `min_cli_version`; clients at the old build refuse manifests until
then, which is the intended failure mode of a leaked key.

## Key custody

Decided 2026-09-23 (sd-240): a repository secret plus an offline escrow copy,
the pattern the Apple signing certificate follows.

- Key id `cli-release-2026`, Ed25519. Public key (base64 raw), the value to pin:
  `4f1kzY89/uJGGB+hvoONtVag56qy1gOkVxhMzLdEc5M=`
- The private PEM is the repository secret `RELEASE_MANIFEST_SIGNING_KEY`; the
  key id is `RELEASE_MANIFEST_KEY_ID`. Step 2 is therefore live: the next
  finalize run signs `latest.json`.
- The escrow copy is in the founder's login Keychain, generic password,
  account `codecast-release`, service
  `codecast release manifest signing key cli-release-2026`. `security -w`
  returns it hex encoded, so read it with
  `security find-generic-password -a codecast-release -s '<service>' -w | xxd -r -p`.
- Step 3 (pinning) waits until a real finalize run has published a
  `latest.json.sig` that `sign-manifest.ts --verify` accepts with this key, so
  a pipeline fault can never meet a pinned client.

Whichever is chosen, the release signing key must never sit on a laptop
release path: `deploy.sh` publishes unsigned, and stays a step 3 compatible
path until step 5, after which laptop publishes of `latest.json` stop working
by design (CI is already the release path for binaries).
