# sample.py <udid> <seconds> <out>: process CPU time of this simulator's Codecast app, 10 times a second
import subprocess, sys, time
udid, secs, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
end = time.time() + secs
def sec(t):
    m, s = t.rsplit(":", 1); return int(m) * 60 + float(s)
with open(out, "w") as f:
    f.write("%.3f launch\n" % time.time()); pid = None
    while time.time() < end:
        if pid is None:
            ps = subprocess.run(["pgrep", "-f", "Devices/%s/.*Codecast.app/Codecast$" % udid], capture_output=True, text=True).stdout.split()
            pid = ps[0] if ps else None
        if pid:
            o = subprocess.run(["ps", "-o", "utime=,stime=,rss=", "-p", pid], capture_output=True, text=True).stdout.split()
            if len(o) == 3: f.write("%.3f %.2f %.2f %s\n" % (time.time(), sec(o[0]), sec(o[1]), o[2])); f.flush()
            else: pid = None
        time.sleep(0.1)
