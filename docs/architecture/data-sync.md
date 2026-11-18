# Data sync: folders outside a repo, on every machine

Some tools keep their data in your home directory, outside any checkout. Codecast's evals keep frozen moments in `~/.local/share/codecast/evals/freezes` and their snapshots beside them. An agent on a cloud host needs the same data the laptop made. Data sync keeps such folders the same on every machine of one person: both Macs and every cloud host, with or without the repo checked out. Decided in sd-3605 (through codecast's own storage, not a git repo per folder and not the one-way home mirror).

## Which folders

A repo declares a folder in `.codecast/workspace.toml`:

```toml
[host]
data = ["~/.local/share/<tool>/<dir>"]
```

`cast datasync add <dir>` registers one with no manifest. Either way the server records the folder for the person (`data_folders`), and from then on every machine of theirs syncs it. A folder must sit at least two levels under `$HOME` and outside credential and agent folders (`.ssh`, `.aws`, `.codecast`, `.claude` and the like); `packages/shared/contracts/dataSync.ts` holds the rule both sides enforce.

The daemon finds declarations in the repos of its codecast panes (`@codecast_project_path`); `cast datasync now` also reads the repo it runs in.

## The index

`convex/dataSync.ts` keeps one row per file (`data_files`): path, sha256, size, the writer's mtime, a tombstone flag, and the storage id of its bytes. Every write takes a `seq` that only grows per person, so a machine reads every change past the last one it saw. Bytes live in Convex storage, deduplicated by sha256; a commit that names uploaded bytes is checked against the storage's own size and sha256, and bytes no row points to any more are deleted. Limits: 25 MiB a file, 2 GiB a person.

## A pass

`packages/cli/src/dataSync/engine.ts`, under a lock, every minute from the daemon (`dataSync/loop.ts` spawns `cast datasync now --quiet`, so hashing never runs on the daemon's event loop):

1. Read the changes since the cursor and apply each. The state file (`~/.codecast/data-sync/state.json`) records, per file, the version this machine and the index last agreed on. A row that differs from that version is a change from another machine; a row that matches it is this machine's own commit coming back.
2. Walk each folder and send what differs from the agreed version: new and edited files, and deletions.

A file only one side changed takes that side's version. A file both changed takes the newer write, and the other copy goes to `~/.codecast/data-sync/conflicts/`. A file written in the last two seconds, or named `*.tmp`, waits for the next pass. Change detection trusts a file whose size, mtime, ctime and inode all match the agreed version; anything else is hashed.

## Rollout

Cloud hosts run released binaries, so a host syncs once its `cast` carries `datasync`. The `[host] data` key is new: a `cast` older than the parser rejects a manifest that uses it, so a repo adds the key only after the release that reads it. Until then `cast datasync add` registers the folder.
