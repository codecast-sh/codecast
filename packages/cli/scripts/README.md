# packages/cli/scripts

Hand-run harnesses that check what no unit test can reach: a real Claude Code pane, a real Mac grant, a cloud host, a paid sandbox. Run them from `packages/cli` with `bun scripts/<name>`. Each file's header holds the full usage, what it proves and what it needs.

## Harnesses

- `relay-e2e.ts`: files a host-to-laptop browser sync command and waits for this laptop's daemon to carry it over SSH, proving the whole relay rail (`--host-device <id> --cdp-port <port>`).
- `vault-dev-server.ts`: standalone loopback bridge serving the `/vault/*` and `/fs/*` routes on a fixed port and token, no daemon needed; pair it with `localStorage.CAST_TERM_ENDPOINT = "<port>:<token>"` in the web app.
- `typed-delivery-soak.ts`: soak test for typed (not pasted) delivery into Claude Code panes, thousands of bursts into real dialogs and a raw reader, with and without CPU load.
- `paste-authority-ablation.ts`: measures whether the "delivered messages are your human's own words" snippet line changes compliance with a pasted authorization, N fresh sessions per arm.
- `prompt-dry-run.ts`: THE way to run a headless `claude -p` that grades a prompt without reaching anyone's inbox; private config dir, empty `CODECAST_DIR`, and the guard `cast` in `prompt-dry-run-bin/` (reads pass, writes refused and logged, `--serve <dir>` answers org reads from files).
- `computer-verify.ts`: `cast computer` procedures on a real Mac (`confirm`, `confirm-swap`, `confirm-route`) plus the helper's `build`, `install`, `dev`, `status` and `cli` plumbing; CI runs its `build`.
- `computer-linux-e2e.sh`: drives every `cast computer` verb on a Linux host (X11 + AT-SPI) from the daemon's bare environment; run it on the host.
- `test-browser-branding.ts`: checks the agent Chrome's branding against a compiled CLI binary; the release workflow runs it.
- `browser-rig.ts`: an isolated end-to-end rig for `cast browser` against the real unpacked extension, away from the human's Chrome and the live bridge; `browser-rig-fixtures/` holds its pages and `lib/chromeRig.ts`, `lib/rigFixtures.ts` its plumbing.
- `browser-secret-flight-e2e.ts`: `type-secret` and `flight` end to end on that rig.
- `browser-stress/soak.ts`, `browser-stress/fuzz.ts`: long-running and randomized `cast browser` runs on the rig (`browser-stress/lib.ts` is shared).
- `check-watch-e2e.ts`: proves `cast check` answers about the files on disk, against real tsc watchers in throwaway git trees.
- `claude-sdk-e2e.ts`: the Claude SDK backend against the real `claude`, with host processes started as the daemon starts them.
- `record-claude-sdk.ts`: records the Claude SDK backend's test fixtures (`src/claudeSdk/__fixtures__/recordings/`) from the real `claude`.
- `reach-e2e.ts`: reached folders (`cloud/reach.ts`) from the laptop against a real cloud host and the real laptop daemon.
- `cloud-agent-canary.ts`: the daily live check of a cloud agent provider's API, run as a trigger precheck (`src/cloudAgents/canary.ts`).
- `computer-bench.ts`: measures `cast computer` against an app that reports its own state (`computer-bench-fixture.swift`), and compares two runs.
- `goal-judge-eval.ts`: grades the session goal judge over `goal-judge-fixtures.ts`, through `prompt-dry-run.ts`.
- `judge-fidelity.ts`: does a judge on a Claude Code subscription answer as it does on the API.
- `line-present-replay.ts`, `judge-review-replay.ts`: replay a line's (or the judge route's) presenting station on a problem with a built fix, posting nothing; `lib/linePresent.ts` is shared and `line-present-replay.test.ts` covers it.
- `moments-shadow.ts`: a judge's shadow run on this machine, extractor and judge over a list of events, nothing sent to the server.
- `agentwatch-replay.ts`: replays Union's AgentWatch history into codecast as moments.
- `e2b-e2e.ts`: live round trip through `E2bBackend` (acquire, exec, files, validate, release) under a five minute wall cap; needs `E2B_API_KEY` and bills E2B by the second.

`lib/claudeScratch.ts` is the throwaway, isolated interactive Claude Code pane that `typed-delivery-soak.ts` and `paste-authority-ablation.ts` share.

## Everything else

- Build and release, called by `package.json`, `deploy.sh` and the release workflows: `build-binaries.sh`, `build-with-native.ts`, `make-formula.sh`, `deploy.sh`, `stamp-daemon-build-id.ts`, `computer-helper-release.ts`, `guard-no-src-shadow.sh`.
- Remote Mac setup, documented in `docs/remote-sessions.md`: `mac-full-setup.sh`, `mac-daemon-bootstrap.sh`.
- `codecast-local`: runs the CLI from source (linked into `~/.local/bin`, see the CLI README).
- Generators for the web's snapshots of shipped flows: `gen-shipped-flows.ts`, `gen-shipped-line.ts` (`src/workflow/shippedFlows.ts`, `shippedLine.ts`).
- `run-interactive.ts`: runs a command as a one-shot launchd job at Interactive priority (`src/interactiveJob.ts`).
- `fugitive-git`: the git shim `cast blame` points vim-fugitive at (`src/blame.ts`).
