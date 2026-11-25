"""Word sources. Each returns {"words": [[w, s, e], ...] | None, "segments": [{start, end, text}],
"cost_usd", "seconds"} for an item's audio; times in file seconds. Results cache per item."""
from __future__ import annotations

import json
import os
import time
import urllib.request
import uuid
from pathlib import Path

from common import CACHE, MODELS, read_json, read_wav, to_mp3, write_json

OPENAI = "https://api.openai.com/v1/audio/transcriptions"
PRICE_PER_MIN = {"whisper-1": 0.006, "gpt-transcribe": 0.0045, "gpt-4o-transcribe-diarize": 0.006,
                 "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003, "scribe_v3": 0.20 / 60,
                 "scribe_v2": 0.22 / 60}


def cached(kind, item, fn, **params):
    key = "-".join([kind] + [f"{k}={v}" for k, v in sorted(params.items()) if v is not None])
    p = CACHE / key / f"{item['id']}.json"
    if p.exists():
        return read_json(p)
    t = time.time()
    out = fn(item, **params)
    out.setdefault("seconds", time.time() - t)
    write_json(p, out)
    return out


def _multipart(fields: dict, files: dict):
    b = uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        for vv in (v if isinstance(v, list) else [v]):
            body += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{vv}\r\n".encode()
    for k, (name, data, mime) in files.items():
        body += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n".encode()
        body += data + b"\r\n"
    body += f"--{b}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={b}"


def _post(url, fields, files, headers, timeout=900):
    body, ctype = _multipart(fields, files)
    req = urllib.request.Request(url, data=body, headers={**headers, "Content-Type": ctype})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:500]
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"{url} {e.code}: {msg}")


def quiet_cuts(audio, target_s, search_s=8.0, frame=0.05):
    """Contiguous pieces of about target_s covering ALL the audio, each cut at the quietest
    frame within search_s of the boundary, so no speech falls between pieces."""
    import numpy as np
    n = int(frame * 16000)
    energy = np.sqrt(np.convolve(audio.astype(np.float64) ** 2, np.ones(n) / n, mode="same") + 1e-12)
    dur = len(audio) / 16000
    cuts, t = [0.0], target_s
    while t < dur - search_s:
        lo, hi = int((t - search_s) * 16000), int((t + search_s) * 16000)
        k = lo + int(np.argmin(energy[lo:hi:n // 2])) * (n // 2)
        cuts.append(k / 16000)
        t = k / 16000 + target_s
    cuts.append(dur)
    return list(zip(cuts[:-1], cuts[1:]))


def chunks_for_upload(audio_path, max_minutes=20):
    return quiet_cuts(read_wav(audio_path), max_minutes * 60, search_s=min(8.0, max_minutes * 15))


def openai_transcribe(item, model="gpt-transcribe", prompt=None, keywords=None, chunk_min=20, language=None):
    from common import to_wav16k
    key = os.environ["OPENAI_API_KEY"]
    segs, words, tmp = [], [], CACHE / "tmp"
    tmp.mkdir(exist_ok=True)
    for (a, b) in chunks_for_upload(item["audio"], chunk_min):
        wav = to_wav16k(item["audio"], tmp / f"{item['id']}-{uuid.uuid4().hex[:8]}.wav", a, b)
        mp3 = to_mp3(wav, wav.with_suffix(".mp3"))
        fields = {"model": model}
        if model == "whisper-1":
            fields.update({"response_format": "verbose_json", "timestamp_granularities[]": ["segment", "word"]})
        else:
            fields["response_format"] = "json"
        if prompt:
            fields["prompt"] = prompt
        if language:
            fields["language"] = language
        if keywords and model.startswith("gpt-transcribe"):
            fields["keywords"] = json.dumps(keywords)
        r = _post(OPENAI, fields, {"file": (mp3.name, mp3.read_bytes(), "audio/mpeg")},
                  {"Authorization": f"Bearer {key}"})
        if r.get("segments"):
            segs += [{"start": a + s["start"], "end": a + s["end"], "text": s["text"].strip()} for s in r["segments"]]
        else:
            segs.append({"start": a, "end": b, "text": r.get("text", "").strip()})
        if r.get("words"):
            words += [[w["word"], a + w["start"], a + w["end"]] for w in r["words"]]
    return {"segments": segs, "words": words or None,
            "cost_usd": PRICE_PER_MIN.get(model, 0.006) * item["duration"] / 60}


_PARAKEET = None


def _parakeet():
    global _PARAKEET
    if _PARAKEET is None:
        import sherpa_onnx
        d = MODELS / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
        _PARAKEET = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(d / "encoder.int8.onnx"), decoder=str(d / "decoder.int8.onnx"),
            joiner=str(d / "joiner.int8.onnx"), tokens=str(d / "tokens.txt"),
            model_type="nemo_transducer", num_threads=int(os.environ.get("LAB_THREADS", "4")))
    return _PARAKEET


def vad_regions(audio, max_len=25.0, min_silence=0.4, threshold=0.5):
    import sherpa_onnx
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(MODELS / "silero_vad.onnx")
    cfg.silero_vad.threshold = threshold
    cfg.silero_vad.min_silence_duration = min_silence
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.silero_vad.max_speech_duration = max_len
    cfg.sample_rate = 16000
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max_len + 10)
    out, w = [], 512
    for i in range(0, len(audio), w):
        vad.accept_waveform(audio[i:i + w])
        while not vad.empty():
            s = vad.front
            out.append((s.start / 16000, (s.start + len(s.samples)) / 16000))
            vad.pop()
    vad.flush()
    while not vad.empty():
        s = vad.front
        out.append((s.start / 16000, (s.start + len(s.samples)) / 16000))
        vad.pop()
    return out


def parakeet(item):
    audio = read_wav(item["audio"])
    rec = _parakeet()
    words, segs = [], []
    for (a, b) in vad_regions(audio):
        st = rec.create_stream()
        st.accept_waveform(16000, audio[int(a * 16000):int(b * 16000)])
        rec.decode_stream(st)
        r = st.result
        cur = None
        for tok, ts in zip(r.tokens, r.timestamps):
            t = a + ts
            if tok.startswith("▁") or tok.startswith(" ") or cur is None:
                if cur:
                    words.append(cur)
                cur = [tok.lstrip("▁ "), t, t + 0.08]
            else:
                cur[0] += tok
                cur[2] = t + 0.08
        if cur:
            words.append(cur)
        if r.text.strip():
            segs.append({"start": a, "end": b, "text": r.text.strip()})
    words = [w for w in words if w[0]]
    # a word ends where the next one starts, capped
    for i in range(len(words) - 1):
        words[i][2] = max(words[i][2], min(words[i + 1][1], words[i][1] + 1.0))
    return {"segments": segs, "words": words, "cost_usd": 0.0}


def run(item, name, **params):
    if name == "live":
        from live import live
        return cached("asr-live", item, live, **params)
    if name == "parakeet":
        return cached("asr-parakeet", item, parakeet)
    if name in ("whisper-1", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"):
        return cached(f"asr-{name}", item, openai_transcribe, model=name, **params)
    if name.startswith("scribe"):
        from vendors import scribe
        return cached(f"asr-{name}", item, scribe, model=name.replace("scribe", "scribe_").replace("__", "_"), **params)
    raise KeyError(name)
