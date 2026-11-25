#!/usr/bin/env python3
"""Find (and optionally remove) Convex storage blobs nothing references.

The self-hosted backend never deletes a blob from its local storage: upstream
calls delete_object only for exports. So every search segment a compaction
replaces, every source package a deploy replaces and every file
ctx.storage.delete removes stays on /srv forever. On 2026-11-24 that was 378 GB
of storage/search, 72 GB of storage/modules and 9 GB of storage/files
(ct-60898).

A blob is garbage only when BOTH hold:
  - no retained revision of the system table that points at it names its key
    (every revision Postgres still holds, not just the latest), and
  - its file is older than --min-age-days (default 7), so an upload whose
    metadata row has not committed yet is never touched.

The reference set is read again immediately before anything is removed, and a
blob is removed only if it is still unreferenced then.

Usage (on convex-prod, as root):
  storage-gc.py                       # dry run: what each directory would free
  storage-gc.py --dir search --quarantine /srv/convex/gc-quarantine
                                      # rename garbage aside (same filesystem,
                                      # instant, frees nothing until purged)
  storage-gc.py --dir search --delete # unlink garbage
"""
import argparse
import os
import re
import subprocess
import sys
import time

STORAGE = "/srv/convex/data/storage"
# Which system tables hold the keys for each storage directory.
DIRS = {
    "search": ["_index"],
    "modules": ["_source_packages", "_modules", "_external_deps_packages"],
    "files": ["_file_storage"],
}
KEY_RE = re.compile(r'"[A-Za-z_]*[Kk]ey":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"')


def psql(sql: str) -> str:
    return subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "postgres", "-d", "codecast", "-At", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout


def table_ids() -> dict:
    """System table name -> tablet id (hex), read from _tables."""
    # _tables is the one table holding a row whose id is its own table_id.
    tables_id = psql(
        "with recursive t(tid) as ((select table_id from documents order by table_id limit 1) union all "
        "select (select table_id from documents where table_id > t.tid order by table_id limit 1) from t where t.tid is not null) "
        "select encode(tid,'hex') from t where tid is not null and exists "
        "(select 1 from documents d where d.table_id=t.tid and d.id=t.tid)"
    ).split()
    if len(tables_id) != 1:
        sys.exit(f"could not identify _tables (found {tables_id})")
    out = {}
    rows = psql(
        "select encode(id,'hex'), convert_from(json_value,'UTF8') from documents "
        f"where table_id=decode('{tables_id[0]}','hex')"
    )
    for line in rows.splitlines():
        tid, _, body = line.partition("|")
        m = re.search(r'"name":"([^"]+)"', body)
        if m:
            out[m.group(1)] = tid
    return out


def referenced_keys(tables: list, ids: dict) -> set:
    keys = set()
    for name in tables:
        tid = ids.get(name)
        if not tid:
            continue
        body = psql(f"select convert_from(json_value,'UTF8') from documents where table_id=decode('{tid}','hex')")
        keys.update(KEY_RE.findall(body))
    return keys


def scan(directory: str, keys: set, min_age_s: float):
    now = time.time()
    garbage, kept_bytes, garbage_bytes = [], 0, 0
    for entry in os.scandir(directory):
        if not entry.is_file(follow_symlinks=False):
            continue
        st = entry.stat(follow_symlinks=False)
        key = entry.name.split(".", 1)[0]
        if key in keys or now - st.st_mtime < min_age_s:
            kept_bytes += st.st_size
        else:
            garbage.append((entry.path, key, st.st_size))
            garbage_bytes += st.st_size
    return garbage, kept_bytes, garbage_bytes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", choices=sorted(DIRS), action="append", help="storage directory (repeatable; default all)")
    ap.add_argument("--min-age-days", type=float, default=7.0)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--delete", action="store_true")
    mode.add_argument("--quarantine", metavar="DIR", help="rename garbage into DIR/<storage dir>/ instead of deleting")
    args = ap.parse_args()
    if args.min_age_days < 2:
        sys.exit("--min-age-days below 2 risks uploads whose metadata has not committed")

    ids = table_ids()
    for name in args.dir or sorted(DIRS):
        directory = os.path.join(STORAGE, name)
        keys = referenced_keys(DIRS[name], ids)
        garbage, kept, gbytes = scan(directory, keys, args.min_age_days * 86400)
        print(f"{name}: {len(keys)} referenced keys; keep {kept/1e9:.1f} GB; garbage {gbytes/1e9:.1f} GB in {len(garbage)} files")
        if not (args.delete or args.quarantine) or not garbage:
            continue
        # Re-read references right before acting; anything newly referenced stays.
        fresh = referenced_keys(DIRS[name], ids)
        target = os.path.join(args.quarantine, name) if args.quarantine else None
        if target:
            os.makedirs(target, exist_ok=True)
        freed = n = 0
        for path, key, size in garbage:
            if key in fresh:
                continue
            try:
                if target:
                    os.rename(path, os.path.join(target, os.path.basename(path)))
                else:
                    os.unlink(path)
            except FileNotFoundError:
                continue
            freed += size
            n += 1
        print(f"  {'quarantined' if target else 'deleted'} {n} files, {freed/1e9:.1f} GB")


if __name__ == "__main__":
    main()
