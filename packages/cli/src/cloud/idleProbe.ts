export const cloudIdleProbeScript = String.raw`#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys
import time

SHELLS = {"bash", "sh", "zsh", "dash", "fish"}
INFRA = {"chrome", "chromium", "chrome_crashpad", "Xvfb", "x11vnc", "websockify", "mediamtx", "sshd"}

def read_processes(proc, uid):
    rows = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != uid:
                continue
            stat = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
            if stat[0] in {"Z", "X"}:
                continue
            argv = (entry / "cmdline").read_bytes().decode(errors="replace").rstrip("\0").split("\0")
            if not argv[0]:
                continue
            rows[int(entry.name)] = {"ppid": int(stat[1]), "argv": argv,
                                     "name": (entry / "comm").read_text().strip()}
        except (FileNotFoundError, ProcessLookupError):
            continue
    return rows

def ancestors(rows, pid):
    seen = set()
    while pid in rows and pid not in seen:
        seen.add(pid)
        yield pid
        pid = rows[pid]["ppid"]

def agent(row):
    name = Path(row["argv"][0]).name
    return row["name"] in {"claude", "codex"} or name in {"claude", "codex"}

def infrastructure(row):
    args = row["argv"]
    names = [Path(a).name for a in args[:3]]
    return (row["name"] in INFRA or "_daemon" in args[:3] or "daemon.ts" in names or
            any(n in {"mcp", "mcp-server", "language-server"} or n.startswith("mcp-server-") for n in names) or
            any("/mcp/" in a or a.endswith("/mcp.js") for a in args[:3]))

def probe(home, proc, now):
    leases = home / ".codecast/host-keepalive"
    if leases.exists():
        for file in leases.iterdir():
            try:
                value = file.read_text().strip()
                if value.isdigit() and now < int(value) <= now + 86400:
                    return {"active": True, "reason": "keepalive"}
            except FileNotFoundError:
                continue
    rows = read_processes(proc, home.stat().st_uid)
    if not rows:
        raise RuntimeError("empty-process-snapshot")
    for pid, row in rows.items():
        chain = list(ancestors(rows, pid))
        anchors = [i for i, p in enumerate(chain[1:], 1) if agent(rows[p]) or rows[p]["name"].startswith("tmux")]
        if not anchors or any(infrastructure(rows[p]) for p in chain[:min(anchors)]):
            continue
        if agent(row) or row["name"].startswith("tmux"):
            continue
        name = Path(row["argv"][0]).name.lstrip("-")
        if name in SHELLS and not any("c" in a for a in row["argv"][1:2] if a.startswith("-")):
            continue
        return {"active": True, "reason": "live-task-process", "pid": pid}
    return {"active": False, "reason": "no-background-work"}

if __name__ == "__main__":
    try:
        result = probe(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/proc"), time.time())
        print(json.dumps(result))
        sys.exit(1 if result["active"] else 0)
    except Exception as error:
        print(json.dumps({"active": True, "reason": "probe-failed", "error": type(error).__name__}))
        sys.exit(2)
`;
