#!/usr/bin/env python3
"""Per-verb latency of the Linux computer helper, run ON a Linux host.

    python3 computer-linux-bench.py run --helper path/to/helper.py --label X --out X.json [--display :98] [--n 15]
    python3 computer-linux-bench.py compare a.json b.json

Starts its own Xvfb (default :98, so the host's :99 and its browser stay
untouched), a gtk3-widget-factory and a Chrome page on it, launches the given
helper.py over its socket protocol, and times each verb end to end on the
socket: the latency an agent sees minus the CLI's own startup. Every fixture,
the display and the helper are stopped on exit.
"""

import json
import os
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time

PAGE = """<!doctype html><title>CC Bench</title>
<h1>Bench</h1>
<label>Name <input id=name placeholder="your name"></label>
<label><input type=checkbox id=agree> Agree</label>
<textarea id=notes rows=3>first line</textarea>
<button onclick="document.getElementById('out').textContent='clicked '+(++window.n||(window.n=1))">Go</button>
<button onclick="setTimeout(()=>{const d=document.createElement('div');d.setAttribute('role','alertdialog');d.setAttribute('aria-label','Late dialog');d.innerHTML='<button>Dismiss</button>';d.querySelector('button').onclick=()=>d.remove();document.body.appendChild(d)},350)">Late</button>
<div id=out>idle</div>
<ul>%s</ul>
""" % "".join("<li>item %d</li>" % i for i in range(1, 41))


class Helper:
    def __init__(self, path, workdir, env):
        self.sock_path = os.path.join(workdir, "helper.sock")
        token_file = os.path.join(workdir, "token")
        self.token = os.urandom(16).hex()
        with open(token_file, "w") as f:
            f.write(self.token)
        self.proc = subprocess.Popen([sys.executable, path, "--agent", self.sock_path, "--token-file", token_file,
                                      "--provider-version", "bench"], env=env, stderr=open(os.path.join(workdir, "helper.err"), "w"))
        deadline = time.time() + 10
        while not os.path.exists(self.sock_path):
            if time.time() > deadline:
                raise SystemExit("helper did not open its socket")
            time.sleep(0.05)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.sock_path)
        self.buf = b""
        self.rid = 0

    def call(self, method, **params):
        self.rid += 1
        params.setdefault("castBinary", os.path.realpath(sys.executable))
        msg = {"id": self.rid, "token": self.token, "method": method, "params": params}
        t0 = time.perf_counter()
        self.sock.sendall((json.dumps(msg) + "\n").encode())
        while b"\n" not in self.buf:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise SystemExit("helper hung up (see helper.err)")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        ms = (time.perf_counter() - t0) * 1000
        reply = json.loads(line)
        if not reply.get("ok"):
            raise RuntimeError("%s: %s" % (method, reply.get("error")))
        return reply["result"], ms

    def close(self):
        try:
            self.call("terminate")
        except Exception:
            pass
        self.proc.terminate()


def index_of(tree, pattern, nth=0):
    hits = [int(m.group(1)) for m in re.finditer(r"^\t*(\d+) " + pattern, tree, re.M)]
    if len(hits) <= nth:
        raise RuntimeError("no element matches %r in:\n%s" % (pattern, tree[:3000]))
    return hits[nth]


def wait_for_app(helper, app, pattern, timeout=40):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            result, _ = helper.call("getAppState", app=app, noScreenshot=True)
            tree = result["snapshot"]["treeText"]
            if re.search(pattern, tree, re.M):
                return tree
            last = tree[:400]
        except RuntimeError as err:
            last = str(err)
        time.sleep(0.5)
    raise SystemExit("%s never showed %r: %s" % (app, pattern, last))


def run(args):
    helper_path = os.path.abspath(args["--helper"])
    display = args.get("--display", ":98")
    n = int(args.get("--n", "15"))
    only = set((args.get("--only") or "gtk,chrome").split(","))
    work = tempfile.mkdtemp(prefix="cc-bench-")
    procs = []
    env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "DISPLAY": display}
    if os.environ.get("XDG_RUNTIME_DIR"):
        env["XDG_RUNTIME_DIR"] = os.environ["XDG_RUNTIME_DIR"]
    num = display.lstrip(":")
    xvfb = None
    if not os.path.exists("/tmp/.X11-unix/X%s" % num):
        xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        procs.append(xvfb)
        for _ in range(50):
            if os.path.exists("/tmp/.X11-unix/X%s" % num):
                break
            time.sleep(0.1)
    helper = None
    results = {}
    try:
        # The helper finds the bus itself, the way the daemon launches it.
        helper = Helper(helper_path, work, env)
        helper.call("handshake")
        helper.call("listApps")  # publishes AT_SPI_BUS on this display before apps start
        page = os.path.join(work, "page.html")
        with open(page, "w") as f:
            f.write(PAGE)
        if "gtk" in only:
            procs.append(subprocess.Popen(["gtk3-widget-factory"], env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, start_new_session=True))
        if "chrome" in only:
            procs.append(subprocess.Popen(["google-chrome", "--user-data-dir=" + os.path.join(work, "chrome"), "--no-first-run",
                                           "--no-default-browser-check", "--window-position=0,0", "--window-size=1000,800",
                                           "--disable-gpu", "file://" + page], env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, start_new_session=True))
        for name in sorted(only):
            results[name] = bench_app(helper, name, procs, n)
    finally:
        if helper:
            helper.close()
        for p in procs:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except Exception:
                pass
        time.sleep(0.5)
        for p in procs:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except Exception:
                pass
        if os.path.exists(os.path.join(work, "helper.err")):
            err = open(os.path.join(work, "helper.err")).read().strip()
            if err:
                sys.stderr.write("helper stderr:\n" + err[-2000:] + "\n")
        shutil.rmtree(work, ignore_errors=True)
    out = {"label": args.get("--label", "run"), "n": n, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "load": os.getloadavg()[0], "results": results}
    text = json.dumps(out, indent=1)
    if args.get("--out"):
        with open(args["--out"], "w") as f:
            f.write(text)
    print_table(out)


def timed(samples, key, fn):
    t0 = time.perf_counter()
    res, ms = fn()
    samples.setdefault(key, []).append(ms)
    return res


def bench_app(helper, name, procs, n):
    samples = {}
    checks = {}
    if name == "gtk":
        app = "gtk3-widget-factory"
        tree = wait_for_app(helper, app, r"slider")
        helper.call("getAppState", app=app, restoreWindow=True, noScreenshot=True)
        for _ in range(n):
            timed(samples, "read", lambda: helper.call("getAppState", app=app, noScreenshot=True))
            timed(samples, "read+shot", lambda: helper.call("getAppState", app=app))
        for i in range(n):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            cb = index_of(tree, r"check box checkbutton", 1)
            timed(samples, "click(action)", lambda: helper.call("click", app=app, elementIndex=cb))
        for i in range(n):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            entry = index_of(tree, r"text field \(settable\)")
            res = timed(samples, "set-value", lambda: helper.call("setValue", app=app, elementIndex=entry, value="v%d" % i))
            checks.setdefault("set-value verified", []).append(res["action"].get("verification", {}).get("state") == "verified")
        tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
        entry = index_of(tree, r"text field \(settable\)")
        helper.call("click", app=app, elementIndex=entry, mouse=True)
        for i in range(n):
            res = timed(samples, "type", lambda: helper.call("typeText", app=app, text="ab"))
            checks.setdefault("type verified", []).append(res["action"].get("verification", {}).get("state") == "verified")
        for i in range(n):
            timed(samples, "key", lambda: helper.call("pressKey", app=app, key="End"))
        for i in range(n):
            timed(samples, "key(chord)", lambda: helper.call("pressKey", app=app, key="Shift+Left"))
        tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
        cb = index_of(tree, r"check box checkbutton", 1)
        for i in range(n):
            timed(samples, "click(mouse)", lambda: helper.call("click", app=app, elementIndex=cb, mouse=True))
    else:
        pid = None
        deadline = time.time() + 40
        while pid is None and time.time() < deadline:
            apps = helper.call("listApps")[0]["apps"]
            pid = next((a["pid"] for a in apps if "chrome" in (a.get("bundleId") or "").lower()
                        or "chrom" in (a.get("name") or "").lower()), None)
            time.sleep(0.5)
        if pid is None:
            raise SystemExit("chrome never joined the accessibility bus")
        app = "pid:%d" % pid
        wait_for_app(helper, app, r"button Go")
        helper.call("getAppState", app=app, restoreWindow=True, noScreenshot=True)
        for _ in range(n):
            timed(samples, "read", lambda: helper.call("getAppState", app=app, noScreenshot=True))
            timed(samples, "read+shot", lambda: helper.call("getAppState", app=app))
        for i in range(n):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            go = index_of(tree, r"button Go")
            res = timed(samples, "click(action)", lambda: helper.call("click", app=app, elementIndex=go))
            checks.setdefault("click shows result", []).append("clicked %d" % (i + 1) in res["snapshot"]["treeText"])
        for i in range(n):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            field = index_of(tree, r"text field \(settable\) Name")
            res = timed(samples, "set-value", lambda: helper.call("setValue", app=app, elementIndex=field, value="name%d" % i))
            checks.setdefault("set-value verified", []).append(res["action"].get("verification", {}).get("state") == "verified")
        for i in range(n):
            res = timed(samples, "type", lambda: helper.call("typeText", app=app, text="ab"))
            checks.setdefault("type verified", []).append(res["action"].get("verification", {}).get("state") == "verified")
        for i in range(n):
            timed(samples, "key", lambda: helper.call("pressKey", app=app, key="End"))
        for i in range(n):
            timed(samples, "key(chord)", lambda: helper.call("pressKey", app=app, key="Shift+Home"))
        # A dialog that arrives 350 ms after the click must be in the result.
        for i in range(max(3, n // 3)):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            late = index_of(tree, r"button Late")
            res = timed(samples, "click(late dialog)", lambda: helper.call("click", app=app, elementIndex=late))
            seen = "Late dialog" in res["snapshot"]["treeText"]
            checks.setdefault("late dialog in result", []).append(seen)
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            for _ in range(5):
                if "Dismiss" not in tree:
                    break
                helper.call("click", app=app, elementIndex=index_of(tree, r"button Dismiss"))
                tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
    stats = {k: {"median": round(statistics.median(v), 1), "p90": round(sorted(v)[int(len(v) * 0.9) - 1 if len(v) > 1 else 0], 1),
                 "n": len(v)} for k, v in samples.items()}
    return {"verbs": stats, "checks": {k: "%d/%d" % (sum(v), len(v)) for k, v in checks.items()}}


def print_table(out):
    print("== %s (n=%d, load %.2f)" % (out["label"], out["n"], out["load"]))
    for app, res in out["results"].items():
        for verb, s in res["verbs"].items():
            print("  %-6s %-20s median %7.1f ms   p90 %7.1f ms" % (app, verb, s["median"], s["p90"]))
        for name, value in res["checks"].items():
            print("  %-6s check %-28s %s" % (app, name, value))


def compare(a_path, b_path):
    a, b = json.load(open(a_path)), json.load(open(b_path))
    print("%-6s %-20s %10s %10s %8s" % ("app", "verb", a["label"], b["label"], "change"))
    for app in a["results"]:
        for verb, s in a["results"][app]["verbs"].items():
            t = b["results"].get(app, {}).get("verbs", {}).get(verb)
            if not t:
                continue
            pct = (t["median"] - s["median"]) / s["median"] * 100 if s["median"] else 0
            print("%-6s %-20s %8.1fms %8.1fms %+7.0f%%" % (app, verb, s["median"], t["median"], pct))
        for name, value in b["results"].get(app, {}).get("checks", {}).items():
            print("%-6s check %-28s %s -> %s" % (app, name, a["results"][app]["checks"].get(name, "-"), value))


def main(argv):
    if not argv or argv[0] not in ("run", "compare"):
        sys.stderr.write(__doc__)
        return 2
    if argv[0] == "compare":
        compare(argv[1], argv[2])
        return 0
    args = {}
    rest = argv[1:]
    for i in range(0, len(rest), 2):
        args[rest[i]] = rest[i + 1] if i + 1 < len(rest) else ""
    run(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
