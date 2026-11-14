#!/usr/bin/env python3
"""Per-verb latency of the Linux computer helper, run ON a Linux host.

    python3 computer-linux-bench.py run --helper path/to/helper.py --label X --out X.json [--display :98] [--n 15]
    python3 computer-linux-bench.py compare a.json[,a2.json] b.json[,b2.json]

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
<canvas id=cv width=120 height=60 style="background:#ddd"></canvas>
<button onclick="const c=document.getElementById('cv').getContext('2d');c.fillStyle=(window.k=!window.k)?'#c33':'#33c';c.fillRect(0,0,120,60)">Paint</button>
<button onclick="document.getElementById('sp').classList.toggle('on')">Spin</button>
<style>#sp{width:30px;height:30px;background:#393}#sp.on{animation:r .4s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style>
<div id=sp></div>
<ul>%s</ul>
""" % "".join("<li>item %d</li>" % i for i in range(1, 41))


# A GTK window whose "Late" button answers 150 ms after the click, past the
# settle's quiet spell: a label in the same window and a modal dialog.
FIXTURE = """
import gi, time
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
GLib.set_prgname("cc-fixture")
win = Gtk.Window(title="CC Fixture")
win.set_default_size(420, 300)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
win.add(box)
entry = Gtk.Entry()
entry.set_placeholder_text("name")
box.add(entry)
box.add(Gtk.CheckButton(label="Agree"))
label = Gtk.Label(label="idle")
box.add(label)
n = [0]
def busy_dialog(_b):
    # The app is busy for 200 ms inside the handler, posting nothing.
    time.sleep(0.2)
    d = Gtk.MessageDialog(transient_for=win, modal=True, message_type=Gtk.MessageType.INFO,
                          buttons=Gtk.ButtonsType.OK, text="Late dialog")
    d.set_title("Late dialog")
    d.connect("response", lambda d, r: d.destroy())
    d.show_all()
def late_label(_b):
    def fire():
        n[0] += 1
        label.set_text("late done %d" % n[0])
        return False
    GLib.timeout_add(150, fire)
def late_dialog(_b):
    def fire():
        d = Gtk.MessageDialog(transient_for=win, modal=True, message_type=Gtk.MessageType.INFO,
                              buttons=Gtk.ButtonsType.OK, text="Late dialog")
        d.set_title("Late dialog")
        d.connect("response", lambda d, r: d.destroy())
        d.show_all()
        return False
    GLib.timeout_add(150, fire)
# A picture the tree does not describe: repainting it changes pixels only.
from gi.repository import GdkPixbuf
color = [0]
area = Gtk.Image()
def fill():
    pix = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 120, 60)
    pix.fill(0xCC3333FF if color[0] % 2 else 0x3333CCFF)
    area.set_from_pixbuf(pix)
fill()
box.add(area)
spinner = Gtk.Spinner()
box.add(spinner)
def paint(_b):
    color[0] += 1
    fill()
def spin(_b):
    spinner.stop() if spinner.props.active else spinner.start()
for name, fn in (("Late label", late_label), ("Late dialog", late_dialog), ("Busy dialog", busy_dialog),
                 ("Paint", paint), ("Spin", spin)):
    b = Gtk.Button(label=name)
    b.connect("clicked", fn)
    box.add(b)
win.connect("destroy", Gtk.main_quit)
win.show_all()
Gtk.main()
"""


UNICODE = "Hé wörld ✓ 日本 😀 A!@#"


class Helper:
    def __init__(self, path, workdir, env, name="helper"):
        self.sock_path = os.path.join(workdir, name + ".sock")
        token_file = os.path.join(workdir, name + ".token")
        self.token = os.urandom(16).hex()
        with open(token_file, "w") as f:
            f.write(self.token)
        self.proc = subprocess.Popen([sys.executable, path, "--agent", self.sock_path, "--token-file", token_file,
                                      "--provider-version", "bench"], env=env, stderr=open(os.path.join(workdir, name + ".err"), "w"))
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
    def body(helper, procs, work, env):
        results = {}
        for name in sorted(set((args.get("--only") or "gtk,fixture,chrome").split(","))):
            results[name] = bench_app(helper, name, procs, int(args.get("--n", "15")))
        return results
    results = with_fixtures(args, body)
    out = {"label": args.get("--label", "run"), "n": int(args.get("--n", "15")), "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "load": os.getloadavg()[0], "results": results}
    if args.get("--out"):
        with open(args["--out"], "w") as f:
            f.write(json.dumps(out, indent=1))
    print_table(out)


def with_fixtures(args, body):
    helper_path = os.path.abspath(args["--helper"])
    display = args.get("--display", ":98")
    only = set((args.get("--only") or "gtk,fixture,chrome").split(","))
    work = tempfile.mkdtemp(prefix="cc-bench-")
    procs = []
    env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "DISPLAY": display}
    if args.get("--phases") is not None:
        env["CODECAST_COMPUTER_TIMING"] = "1"
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
    try:
        # The helper finds the bus itself, the way the daemon launches it.
        helper = Helper(helper_path, work, env)
        helper.call("handshake")
        helper.call("listApps")  # publishes AT_SPI_BUS on this display before apps start
        page = os.path.join(work, "page.html")
        with open(page, "w") as f:
            f.write(PAGE)
        if "fixture" in only:
            fixture = os.path.join(work, "fixture.py")
            with open(fixture, "w") as f:
                f.write(FIXTURE)
            procs.append(subprocess.Popen(["/usr/bin/python3", fixture], env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, start_new_session=True))
        if "gtk" in only:
            procs.append(subprocess.Popen(["gtk3-widget-factory"], env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, start_new_session=True))
        if "chrome" in only:
            procs.append(subprocess.Popen(["google-chrome", "--user-data-dir=" + os.path.join(work, "chrome"), "--no-first-run",
                                           "--no-default-browser-check", "--window-position=0,0", "--window-size=1000,800",
                                           "--disable-gpu", "file://" + page], env=env, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, start_new_session=True))
        return body(helper, procs, work, env)
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
            phases = {}
            for line in err.splitlines():
                if line.startswith("timing "):
                    _, method, data = line.split(" ", 2)
                    for k, v in json.loads(data).items():
                        phases.setdefault(method, {}).setdefault(k, []).append(v)
            err = "\n".join(l for l in err.splitlines() if not l.startswith("timing "))
            for method, spent in sorted(phases.items()):
                print("  phases %-14s %s" % (method, "  ".join("%s %.1f" % (k, statistics.median(v)) for k, v in spent.items())))
            if err:
                sys.stderr.write("helper stderr:\n" + err[-2000:] + "\n")
        shutil.rmtree(work, ignore_errors=True)


def timed(samples, key, fn):
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
    elif name == "fixture":
        app = "cc-fixture"
        wait_for_app(helper, app, r"button Late dialog")
        helper.call("getAppState", app=app, restoreWindow=True, noScreenshot=True)
        for _ in range(n):
            timed(samples, "read", lambda: helper.call("getAppState", app=app, noScreenshot=True))
        for i in range(n):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            late = index_of(tree, r"button Late label")
            res = timed(samples, "click(late label)", lambda: helper.call("click", app=app, elementIndex=late))
            checks.setdefault("late label in result", []).append("late done %d" % (i + 1) in res["snapshot"]["treeText"])
        for i in range(max(3, n // 2)):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            late = index_of(tree, r"button Late dialog")
            res = timed(samples, "click(late dialog)", lambda: helper.call("click", app=app, elementIndex=late))
            checks.setdefault("late dialog in result", []).append('the dialog "Late dialog"' in res["snapshot"]["treeText"])
            time.sleep(0.5)
            wins = helper.call("listWindows", app=app)[0]["windows"]
            for w in wins:
                if w["title"] == "Late dialog":
                    t = helper.call("getAppState", app=app, windowId=w["id"], noScreenshot=True)[0]["snapshot"]["treeText"]
                    helper.call("click", app=app, windowId=w["id"], elementIndex=index_of(t, r"button OK"))
        for i in range(max(3, n // 2)):
            tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
            busy = index_of(tree, r"button Busy dialog")
            res = timed(samples, "click(busy dialog)", lambda: helper.call("click", app=app, elementIndex=busy))
            checks.setdefault("busy dialog in result", []).append('the dialog "Late dialog"' in res["snapshot"]["treeText"])
            time.sleep(0.3)
            for w in helper.call("listWindows", app=app)[0]["windows"]:
                if w["title"] == "Late dialog":
                    t = helper.call("getAppState", app=app, windowId=w["id"], noScreenshot=True)[0]["snapshot"]["treeText"]
                    helper.call("click", app=app, windowId=w["id"], elementIndex=index_of(t, r"button OK"))
        # Back to back actions on an unchanged window: no walk before the second.
        tree = helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
        agree = index_of(tree, r"check box Agree")
        for i in range(n):
            timed(samples, "click(check)", lambda: helper.call("click", app=app, elementIndex=agree))
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
        # Characters the US layout lacks go through temporary keycode bindings.
        for i in range(max(3, n // 3)):
            res = timed(samples, "type(unicode)", lambda: helper.call("typeText", app=app, text=UNICODE))
            checks.setdefault("unicode typed exactly", []).append(res["action"].get("verification", {}).get("state") == "verified")
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
    repaint_checks(helper, app, samples, checks, n)
    stats = {k: {"median": round(statistics.median(v), 1), "p90": round(sorted(v)[int(len(v) * 0.9) - 1 if len(v) > 1 else 0], 1),
                 "n": len(v)} for k, v in samples.items()}
    return {"verbs": stats, "samples": samples, "checks": {k: [sum(v), len(v)] for k, v in checks.items()}}


def repaint_checks(helper, app, samples, checks, n):
    """A paint the tree does not show must come back as changed pixels, and as
    repainting while a spinner animates in the same window."""
    if app == "gtk3-widget-factory":
        return
    def tree():
        return helper.call("getAppState", app=app, noScreenshot=True)[0]["snapshot"]["treeText"]
    # Focus the button first, so a click changes nothing the tree shows.
    helper.call("click", app=app, elementIndex=index_of(tree(), r"button Paint"), mouse=True)
    for spinning in (False, True):
        label = "paint(spinner)" if spinning else "paint"
        for i in range(max(3, n // 2)):
            res = timed(samples, "click(%s)" % label, lambda: helper.call("click", app=app, elementIndex=index_of(tree(), r"button Paint")))
            pc = res.get("pixelChange") or {}
            ok = pc.get("changed") is not None and ((pc.get("repainting") is not None) == spinning)
            checks.setdefault("%s: pixels %s" % (label, "repainting" if spinning else "changed, not repainting"), []).append(ok)
            if not ok:
                lines = res["snapshot"]["treeText"].splitlines()
                sys.stderr.write("repaint miss %s %s: pixelChange=%s baseline_same=%s focus=%s\n" % (
                    app, label, pc or None, res.get("baselineTreeText") == res["snapshot"]["treeText"], lines[-1]))
        if not spinning:
            helper.call("click", app=app, elementIndex=index_of(tree(), r"button Spin"))
            helper.call("click", app=app, elementIndex=index_of(tree(), r"button Paint"), mouse=True)
            time.sleep(0.3)
    helper.call("click", app=app, elementIndex=index_of(tree(), r"button Spin"))


def print_table(out):
    print("== %s (n=%d, load %.2f)" % (out["label"], out["n"], out["load"]))
    for app, res in out["results"].items():
        for verb, s in res["verbs"].items():
            print("  %-6s %-20s median %7.1f ms   p90 %7.1f ms" % (app, verb, s["median"], s["p90"]))
        for name, (ok, total) in res["checks"].items():
            print("  %-6s check %-28s %d/%d" % (app, name, ok, total))


def merged(paths):
    """Several passes of one label as one: every sample pooled."""
    out = {"label": None, "results": {}}
    for path in paths.split(","):
        run = json.load(open(path))
        out["label"] = out["label"] or run["label"]
        for app, res in run["results"].items():
            slot = out["results"].setdefault(app, {"samples": {}, "checks": {}})
            for verb, values in res["samples"].items():
                slot["samples"].setdefault(verb, []).extend(values)
            for name, (ok, total) in res["checks"].items():
                prev = slot["checks"].get(name, [0, 0])
                slot["checks"][name] = [prev[0] + ok, prev[1] + total]
    return out


def compare(a_paths, b_paths):
    a, b = merged(a_paths), merged(b_paths)
    print("%-8s %-20s %10s %10s %8s" % ("app", "verb", a["label"], b["label"], "change"))
    for app, res in a["results"].items():
        other = b["results"].get(app)
        if not other:
            continue
        for verb, values in res["samples"].items():
            if verb not in other["samples"]:
                continue
            ma, mb = statistics.median(values), statistics.median(other["samples"][verb])
            print("%-8s %-20s %8.1fms %8.1fms %+7.0f%%" % (app, verb, ma, mb, (mb - ma) / ma * 100 if ma else 0))
        for name, (ok, total) in other["checks"].items():
            pa = res["checks"].get(name)
            print("%-8s check %-26s %s -> %d/%d" % (app, name, "%d/%d" % tuple(pa) if pa else "-", ok, total))


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
