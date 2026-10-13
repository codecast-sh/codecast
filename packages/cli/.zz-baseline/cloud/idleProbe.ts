export const cloudIdleProbeScript = String.raw`#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys
import shlex
import time

SHELLS = {"bash", "sh", "zsh", "dash", "fish"}
INFRA = {"chrome", "chromium", "chrome_crashpad", "Xvfb", "x11vnc", "websockify", "mediamtx", "sshd"}

def read_processes(proc):
    rows = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
            if stat[0] in {"Z", "X"}:
                continue
            argv = (entry / "cmdline").read_bytes().decode(errors="replace").rstrip("\0").split("\0")
            if not argv[0]:
                continue
            uid = int((entry / "status").read_text().split("Uid:", 1)[1].split()[0])
            rows[int(entry.name)] = {"ppid": int(stat[1]), "argv": argv, "uid": uid, "tty": int(stat[4]), "ticks": int(stat[11]) + int(stat[12]), "start": stat[19],
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

def headless_agent(row):
    args = row["argv"][1:]
    if row["name"] == "claude" or Path(row["argv"][0]).name == "claude":
        return any(a in {"-p", "--print"} for a in args)
    takes_value = {"-c", "--config", "-p", "--profile", "-m", "--model", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval", "--enable", "--disable"}
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in takes_value:
            skip = True
        elif arg == "--":
            return False
        elif not arg.startswith("-"):
            return arg in {"exec", "e", "review"}
    return False

def shell_has_work(args):
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in {"--rcfile", "--init-file", "-o", "+o", "-O", "+O"}:
            skip = True
        elif arg.startswith("--"):
            continue
        elif arg.startswith(("-", "+")):
            if "c" in arg[1:] or "s" in arg[1:]:
                return True
        else:
            return True
    return False

def infrastructure(row):
    args = row["argv"]
    if args[0].startswith("npm exec "):
        args = shlex.split(args[0])
    command = Path(args[0]).name.lstrip("-")
    if command in SHELLS:
        return False
    if row["name"] in INFRA:
        return True
    entry = args[0]
    if command in {"node", "bun", "python", "python3"}:
        if len(args) < 2 or args[1].startswith("-"):
            return False
        entry = args[2] if args[1] == "run" and len(args) > 2 else args[1]
    elif command in {"npm", "npx", "uvx"}:
        operands = [a for a in args[1:] if not a.startswith("-") and a != "exec"]
        if not operands:
            return False
        entry = operands[0]
    if command in {"cast", "codecast"} and len(args) > 1 and args[1] in {"mcp", "_daemon"}:
        return True
    if "/codecast/" in entry and "_daemon" in args[2:3]:
        return True
    parts = Path(entry).parts
    return (Path(entry).name.startswith("mcp-server-") or
            any(p == "@modelcontextprotocol" and parts[i + 1].startswith("server-") or
                p == "@playwright" and parts[i + 1] == "mcp"
                for i, p in enumerate(parts[:-1])))

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
    uid = home.stat().st_uid
    rows = read_processes(proc)
    if not rows:
        raise RuntimeError("empty-process-snapshot")
    cpu_candidates = set()
    for pid, row in rows.items():
        chain = list(ancestors(rows, pid))
        anchors = [i for i, p in enumerate(chain[1:], 1) if rows[p]["uid"] == uid and (agent(rows[p]) or rows[p]["name"].startswith("tmux"))]
        headless = agent(row) and headless_agent(row)
        if agent(row) and row["uid"] == uid and not headless:
            cpu_candidates.add(pid)
        if not anchors and not (headless and row["uid"] == uid):
            continue
        if any(infrastructure(rows[p]) for p in chain[:min(anchors) if anchors else 1]):
            continue
        if agent(row):
            if headless:
                return {"active": True, "reason": "headless-agent", "pid": pid}
            continue
        if row["name"].startswith("tmux"):
            continue
        name = Path(row["argv"][0]).name.lstrip("-")
        if name in SHELLS:
            if any(child["ppid"] == pid for child in rows.values()):
                cpu_candidates.add(pid)
                continue
            if row["tty"] != 0 and not shell_has_work(row["argv"][1:]):
                cpu_candidates.add(pid)
                continue
        return {"active": True, "reason": "live-task-process", "pid": pid}
    if cpu_candidates:
        time.sleep(0.25)
        for pid in cpu_candidates:
            try:
                stat = (proc / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
                if stat[0] not in {"Z", "X"} and (stat[19] != rows[pid]["start"] or int(stat[11]) + int(stat[12]) > rows[pid]["ticks"]):
                    return {"active": True, "reason": "process-cpu", "pid": pid}
            except (FileNotFoundError, ProcessLookupError):
                continue
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
