"""Check a running worker against a lab fixture, and its error answers.

  python parity_test.py --worker http://localhost:8080 \
      --audio ~/.codecast/diarize-lab/ami/IS1009b/IS1009b.sdm16k.wav \
      --fixture ~/.codecast/diarize-lab/fixtures/IS1009b.json

Serves --audio from a local http server (the worker must run with
ALLOW_HTTP_AUDIO=1), or pass --audio-url for a file already online. Sends the
fixture's `clusters` windows and requires every returned vector to match the
fixture's (cosine >= 0.999; the fixture rounds to 4 decimals). The secret comes
from SPEECH_WORKER_SECRET. Exits nonzero on any failure.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np


def call(base, path, body=None, secret=None, timeout=900):
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers["Authorization"] = f"Bearer {secret}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def serve_dir(directory, host):
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("0.0.0.0", 0), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://{host}:{srv.server_address[1]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", required=True)
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--audio", help="local audio file to serve to the worker")
    ap.add_argument("--audio-url", help="an already public URL for the same audio")
    ap.add_argument("--audio-host", default=None,
                    help="host the worker uses to reach this machine (host.docker.internal from a container)")
    ap.add_argument("--min-cos", type=float, default=0.999)
    ap.add_argument("--skip-errors", action="store_true", help="only the parity check")
    a = ap.parse_args()
    secret = os.environ.get("SPEECH_WORKER_SECRET")
    if not secret:
        sys.exit("SPEECH_WORKER_SECRET is not set")

    junk_url = playlist_url = redirect_url = None
    if a.audio_url:
        audio_url = a.audio_url
    else:
        served = Path(tempfile.mkdtemp(prefix="speech-parity-"))
        src = Path(a.audio).expanduser().resolve()
        (served / src.name).symlink_to(src)
        (served / "junk.webm").write_bytes(os.urandom(4096))
        # An HLS playlist dressed as a recording: ffmpeg must not follow it.
        (served / "playlist.webm").write_text(
            "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://169.254.169.254/latest\n#EXT-X-ENDLIST\n")
        (served / "dir").mkdir()  # the file server answers /dir with a 301 to /dir/
        base = serve_dir(served, a.audio_host or "127.0.0.1")
        audio_url, junk_url = f"{base}/{src.name}", f"{base}/junk.webm"
        playlist_url, redirect_url = f"{base}/playlist.webm", f"{base}/dir"

    fixture = json.loads(Path(a.fixture).expanduser().read_text())
    clusters = {k: v for k, v in fixture["clusters"].items() if v}
    spans = [{"key": k, "windows": [[w["start"], w["end"]] for w in ws]} for k, ws in clusters.items()]
    dims = len(next(iter(clusters.values()))[0]["vector"])
    failures = []

    status, health = call(a.worker, "/health")
    print("health", status, health)
    if status != 200 or health != {"ok": True, "model": "campplus-v1"}:
        failures.append(f"/health answered {status} {health}")

    t0 = time.monotonic()
    status, res = call(a.worker, "/embed", {"audio_url": audio_url, "spans": spans}, secret)
    took = time.monotonic() - t0
    n = sum(len(s["windows"]) for s in spans)
    if status != 200:
        failures.append(f"/embed answered {status} {res}")
    else:
        cos = []
        for k, ws in clusters.items():
            got = res["vectors"].get(k)
            if got is None or len(got) != len(ws):
                failures.append(f"{k}: expected {len(ws)} vectors, got {None if got is None else len(got)}")
                continue
            for w, v in zip(ws, got):
                if v is None or len(v) != dims:
                    failures.append(f"{k} [{w['start']:.2f}, {w['end']:.2f}]: vector {v if v is None else len(v)}")
                    continue
                e, g = np.array(w["vector"]), np.array(v)
                cos.append(float(e @ g / (np.linalg.norm(e) * np.linalg.norm(g))))
                if abs(np.linalg.norm(g) - 1) > 1e-4:
                    failures.append(f"{k}: vector norm {np.linalg.norm(g):.6f}")
        if cos:
            print(f"parity: {len(cos)}/{n} windows, min cosine {min(cos):.6f}, mean {np.mean(cos):.6f}, "
                  f"duration_s {res['duration_s']}, {took:.2f}s")
            if min(cos) < a.min_cos:
                failures.append(f"min cosine {min(cos):.6f} < {a.min_cos}")

    if not a.skip_errors:
        w = spans[0]["windows"][0]
        cases = [
            ("bad secret", {"audio_url": audio_url, "spans": spans}, "wrong", 401),
            ("no spans", {"audio_url": audio_url}, secret, 400),
            ("bad window", {"audio_url": audio_url, "spans": [{"key": "a", "windows": [[5, 2]]}]}, secret, 400),
            ("too many windows", {"audio_url": audio_url, "spans": [{"key": "a", "windows": [w] * 601}]}, secret, 413),
            ("download fails", {"audio_url": audio_url + ".missing", "spans": spans[:1]}, secret, 502),
            ("undecodable", {"audio_url": junk_url, "spans": spans[:1]}, secret, 422),
            ("playlist refused", {"audio_url": playlist_url, "spans": spans[:1]}, secret, 422),
            ("redirect refused", {"audio_url": redirect_url, "spans": spans[:1]}, secret, 502),
            ("host not allowed", {"audio_url": "https://example.com/a.webm", "spans": spans[:1]}, secret, 400),
        ]
        for name, body, sec, want in cases:
            if "audio_url" in body and body["audio_url"] is None:
                continue  # needs the local file server
            status, res = call(a.worker, "/embed", body, sec)
            print(f"{name}: {status} {res.get('error')}")
            if status != want:
                failures.append(f"{name}: expected {want}, got {status} {res}")
        # A short window gets a null vector; one past the end is cut to the audio.
        status, res = call(a.worker, "/embed", {"audio_url": audio_url, "spans": [
            {"key": "short", "windows": [[w[0], w[0] + 0.3], [w[0], w[0] + 0.6]]}]}, secret)
        vs = res.get("vectors", {}).get("short") if status == 200 else None
        print("short window:", status, None if vs is None else [None if v is None else len(v) for v in vs])
        if not vs or vs[0] is not None or vs[1] is None or len(vs[1]) != dims:
            failures.append(f"short window: expected [null, vector], got {status}")

    if failures:
        print("FAIL")
        for f in failures:
            print("  ", f)
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
