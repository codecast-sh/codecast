"""CAM++ voice vectors for audio spans, served over HTTP for Convex.

Same model and math as the speech lab (packages/evals/speech/lab/identify.py
`embed`): sherpa-onnx SpeakerEmbeddingExtractor over 16 kHz mono float32,
L2-normalized, 512 dims. The README has the contract.
"""
from __future__ import annotations

import hmac
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MODEL_NAME = "campplus-v1"
MODEL_PATH = os.environ.get("MODEL_PATH", "/models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx")
SECRET = os.environ.get("SPEECH_WORKER_SECRET", "")
PORT = int(os.environ.get("PORT", "8080"))
THREADS = int(os.environ.get("EMBED_THREADS", "1"))
# Plain http audio URLs are for local tests only.
ALLOW_HTTP = os.environ.get("ALLOW_HTTP_AUDIO") == "1"
# Hosts audio may come from (Convex storage). Required: an empty list refuses every URL.
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("ALLOWED_AUDIO_HOSTS", "").split(",") if h.strip()}

SR = 16000
DIMS = 512  # CAM++ en voxceleb emits 512, as the lab fixtures do
MIN_WINDOW_S = 0.5
MAX_AUDIO_BYTES = 2 * 1024**3
MAX_DECODED_S = 4 * 3600  # 4 h of 16 kHz float32 is 0.9 GB
# Demuxers for the containers recordings come in. Playlist and concat demuxers
# (hls, concat) are left out so an uploaded file cannot name other inputs.
DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,wav,mp3,aac,flac"
MAX_WINDOWS = 600
MAX_BODY_BYTES = 4 * 1024**2
REQUEST_CAP_S = 600.0
MAX_WAITING = 4  # requests queued behind the one running; more get 503

_extractor = None
_run_lock = threading.Lock()  # one request computes at a time
_waiting = threading.Semaphore(MAX_WAITING + 1)


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def extractor():
    global _extractor
    if _extractor is None:
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL_PATH, num_threads=THREADS)
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    return _extractor


def embed(audio: np.ndarray, start: float, end: float):
    """The lab's `embed`, on audio already decoded to 16 kHz mono float32."""
    a = audio[int(start * SR):int(end * SR)]
    if len(a) < MIN_WINDOW_S * SR:
        return None
    ex = extractor()
    st = ex.create_stream()
    st.accept_waveform(SR, a)
    st.input_finished()
    v = np.array(ex.compute(st), dtype=np.float32)
    v /= np.linalg.norm(v) + 1e-9
    return [float(x) for x in v]


def parse_body(raw: bytes):
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HttpError(400, "body: not JSON")
    if not isinstance(body, dict):
        raise HttpError(400, "body: expected an object")
    url = body.get("audio_url")
    if not isinstance(url, str) or not url:
        raise HttpError(400, "audio_url: expected a non-empty string")
    parsed = urllib.parse.urlsplit(url)
    if not (parsed.scheme == "https" or (ALLOW_HTTP and parsed.scheme == "http")):
        raise HttpError(400, "audio_url: expected an https URL")
    if (parsed.hostname or "").lower() not in ALLOWED_HOSTS:
        raise HttpError(400, f"audio_url: host {parsed.hostname!r} is not allowed")
    spans = body.get("spans")
    if not isinstance(spans, list) or not spans:
        raise HttpError(400, "spans: expected a non-empty array")
    out, total = [], 0
    for i, span in enumerate(spans):
        if not isinstance(span, dict):
            raise HttpError(400, f"spans[{i}]: expected an object")
        key = span.get("key")
        if not isinstance(key, str) or not key:
            raise HttpError(400, f"spans[{i}].key: expected a non-empty string")
        if any(k == key for k, _ in out):
            raise HttpError(400, f"spans[{i}].key: duplicate key {key!r}")
        windows = span.get("windows")
        if not isinstance(windows, list):
            raise HttpError(400, f"spans[{i}].windows: expected an array")
        ws = []
        for j, w in enumerate(windows):
            ok = (isinstance(w, list) and len(w) == 2
                  and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in w)
                  and 0 <= w[0] <= w[1])
            if not ok:
                raise HttpError(400, f"spans[{i}].windows[{j}]: expected [start_s, end_s] with 0 <= start <= end")
            ws.append((float(w[0]), float(w[1])))
        total += len(ws)
        out.append((key, ws))
    if total > MAX_WINDOWS:
        raise HttpError(413, f"spans: {total} windows, at most {MAX_WINDOWS}")
    return url, out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HttpError(502, f"audio_url: download answered a {code} redirect; redirects are refused")


_opener = urllib.request.build_opener(_NoRedirect)


def download(url: str, dest: str, deadline: float):
    req = urllib.request.Request(url, headers={"User-Agent": "speech-worker"})
    try:
        with _opener.open(req, timeout=60) as r:
            length = r.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > MAX_AUDIO_BYTES:
                raise HttpError(413, "audio_url: file over 2 GB")
            got = 0
            with open(dest, "wb") as f:
                while chunk := r.read(1 << 20):
                    got += len(chunk)
                    if got > MAX_AUDIO_BYTES:
                        raise HttpError(413, "audio_url: file over 2 GB")
                    if time.monotonic() > deadline:
                        raise HttpError(504, "request ran past the 10 min cap while downloading")
                    f.write(chunk)
    except HttpError:
        raise
    except urllib.error.HTTPError as e:
        raise HttpError(502, f"audio_url: download answered {e.code}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HttpError(502, f"audio_url: download failed ({e})")


def decode(src: str, deadline: float) -> np.ndarray:
    """A recording -> 16 kHz mono float32, once per request, at most MAX_DECODED_S.

    ffmpeg reads the file from stdin (the fd protocol, seekable, so an m4a with
    its index at the end still decodes) and may open no other protocol or demuxer.
    """
    pcm = src + ".f32"
    try:
        with open(src, "rb") as f:
            subprocess.run(
                ["ffmpeg", "-v", "error", "-protocol_whitelist", "fd", "-format_whitelist", DEMUXERS, "-i", "fd:",
                 "-vn", "-ac", "1", "-ar", str(SR), "-t", str(MAX_DECODED_S), "-f", "f32le", pcm],
                stdin=f, check=True, capture_output=True, timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        raise HttpError(504, "request ran past the 10 min cap while decoding")
    except subprocess.CalledProcessError as e:
        tail = e.stderr.decode(errors="replace").strip().splitlines()[-1:] or [""]
        raise HttpError(422, f"audio: ffmpeg could not decode it ({tail[0][:200]})")
    audio = np.fromfile(pcm, dtype=np.float32)
    if audio.size == 0:
        raise HttpError(422, "audio: no audio stream")
    return audio


def run_embed(url: str, spans, deadline: float):
    tmp = tempfile.mkdtemp(prefix="speech-")
    try:
        src = os.path.join(tmp, "audio")
        download(url, src, deadline)
        audio = decode(src, deadline)
        os.unlink(src)
        vectors = {}
        for key, ws in spans:
            vs = []
            for a, b in ws:
                if time.monotonic() > deadline:
                    raise HttpError(504, "request ran past the 10 min cap while embedding")
                vs.append(embed(audio, a, b))
            vectors[key] = vs
        return {"model": MODEL_NAME, "vectors": vectors, "duration_s": round(audio.size / SR, 3)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_json(self, status: int, obj):
        data = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "model": MODEL_NAME})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        started = time.monotonic()
        deadline = started + REQUEST_CAP_S
        try:
            if self.path != "/embed":
                raise HttpError(404, "not found")
            auth = self.headers.get("Authorization", "")
            if not hmac.compare_digest(auth.encode(), f"Bearer {SECRET}".encode()):
                raise HttpError(401, "bad secret")
            length = self.headers.get("Content-Length")
            if not length or not length.isdigit():
                raise HttpError(400, "body: Content-Length required")
            if int(length) > MAX_BODY_BYTES:
                raise HttpError(413, "body: over 4 MB")
            url, spans = parse_body(self.rfile.read(int(length)))
            if not _waiting.acquire(blocking=False):
                raise HttpError(503, "busy: queue full")
            try:
                if not _run_lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
                    raise HttpError(504, "request ran past the 10 min cap waiting in the queue")
                try:
                    result = run_embed(url, spans, deadline)
                finally:
                    _run_lock.release()
            finally:
                _waiting.release()
            n = sum(len(ws) for _, ws in spans)
            self.log_message("embed %d windows, %.1fs audio, %.2fs", n, result["duration_s"], time.monotonic() - started)
            self.send_json(200, result)
        except HttpError as e:
            self.log_message("error %d: %s", e.status, e.message)
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # noqa: BLE001
            self.log_message("error 500: %r", e)
            self.send_json(500, {"error": "internal error"})


def main():
    if not SECRET:
        raise SystemExit("SPEECH_WORKER_SECRET is not set")
    if not ALLOWED_HOSTS:
        raise SystemExit("ALLOWED_AUDIO_HOSTS is not set")
    extractor()  # load the model before taking traffic
    if extractor().dim != DIMS:
        raise SystemExit(f"model has {extractor().dim} dims, expected {DIMS}")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"speech-worker {MODEL_NAME} listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
