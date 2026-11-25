"""Hosted stacks: ElevenLabs Scribe (words, word times, diarization) and pyannoteAI (diarization,
identification against voiceprints). Keys: ELEVENLABS_API_KEY, PYANNOTE_API_KEY (cast vault run)."""
from __future__ import annotations

import json
import os
import time
import urllib.request
import uuid

from asr import PRICE_PER_MIN, _post
from common import CACHE, to_mp3, to_wav16k

PYA = "https://api.pyannote.ai/v1"
PYA_PER_HOUR_EUR = {"precision-2": 0.112, "precision-3": 0.112, "community-1": 0.035}


def scribe(item, model="scribe_v3", language=None, keyterms=None, num_speakers=None, threshold=None):
    fields = {"model_id": model, "diarize": "true", "timestamps_granularity": "word", "tag_audio_events": "false"}
    if language:
        fields["language_code"] = language
    if num_speakers:
        fields["num_speakers"] = str(num_speakers)
    if threshold:
        fields["diarization_threshold"] = str(threshold)
    if keyterms:
        fields["keyterms"] = [k for k in str(keyterms).split("+") if k]
    mp3 = to_mp3(item["audio"], CACHE / "tmp" / f"{item['id']}-{uuid.uuid4().hex[:6]}.mp3", kbps=64)
    r = _post("https://api.elevenlabs.io/v1/speech-to-text", fields,
              {"file": (mp3.name, mp3.read_bytes(), "audio/mpeg")}, {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
              timeout=1800)
    words = [[w["text"], w["start"], w["end"], w.get("speaker_id")] for w in r.get("words", [])
             if w.get("type") == "word" and w.get("start") is not None]
    turns, cur = [], None
    for (t, s, e, spk) in words:
        if cur and cur["speaker"] == spk and s - cur["end"] < 0.5:
            cur["end"] = e
        else:
            if cur:
                turns.append(cur)
            cur = {"speaker": spk, "start": s, "end": e}
    if cur:
        turns.append(cur)
    per_min = PRICE_PER_MIN.get(model, 0.2 / 60) * (1.2 if keyterms else 1.0)
    return {"words": [w[:3] for w in words], "word_speakers": [w[3] for w in words], "turns": turns,
            "segments": [{"start": t["start"], "end": t["end"], "text": ""} for t in turns],
            "language": r.get("language_code"), "cost_usd": per_min * item["duration"] / 60}


def _pya(method, path, body=None):
    req = urllib.request.Request(PYA + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {os.environ['PYANNOTE_API_KEY']}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"pyannote {path} {e.code}: {e.read().decode()[:400]}")


def _pya_upload(path):
    key = f"media://lab-{uuid.uuid4().hex}"
    put = _pya("POST", "/media/input", {"url": key})["url"]
    data = open(path, "rb").read()
    req = urllib.request.Request(put, method="PUT", data=data, headers={"Content-Type": "application/octet-stream"})
    urllib.request.urlopen(req, timeout=600).read()
    return key


def _pya_job(job_id, every=5, limit=3600):
    t = time.time()
    while time.time() - t < limit:
        j = _pya("GET", f"/jobs/{job_id}")
        if j["status"] in ("succeeded", "failed", "canceled"):
            if j["status"] != "succeeded":
                raise RuntimeError(f"pyannote job {job_id} {j['status']}: {json.dumps(j)[:300]}")
            return j["output"]
        time.sleep(every)
    raise TimeoutError(job_id)


def pyannote_voiceprint(clips):
    """clips: [(audio_path, start, end)] of one person, cut to <= 30 s total -> voiceprint string."""
    import numpy as np
    import soundfile as sf
    from common import read_wav
    parts, tot = [], 0.0
    for (p, a, b) in sorted(clips, key=lambda c: c[1] - c[2]):
        if tot >= 29:
            break
        b = min(b, a + 29 - tot)
        parts.append(read_wav(p)[int(a * 16000):int(b * 16000)])
        tot += b - a
    path = CACHE / "tmp" / f"vp-{uuid.uuid4().hex[:8]}.wav"
    sf.write(str(path), np.concatenate(parts), 16000)
    out = _pya_job(_pya("POST", "/voiceprint", {"url": _pya_upload(path)})["jobId"])
    return out["voiceprint"]


def pyannoteai_diarize(item, model="precision-2", voiceprints=None, threshold=50, exclusive=True):
    """voiceprints: {person: voiceprint}. With them, /identify (diarization + names); else /diarize."""
    wav = to_wav16k(item["audio"], CACHE / "tmp" / f"{item['id']}-{uuid.uuid4().hex[:6]}.wav")
    url = _pya_upload(wav)
    if voiceprints:
        body = {"url": url, "voiceprints": [{"label": k, "voiceprint": v} for k, v in voiceprints.items()],
                "matching": {"threshold": threshold, "exclusive": bool(exclusive)}}
        out = _pya_job(_pya("POST", "/identify", body)["jobId"])
        turns = [{"speaker": s["diarizationSpeaker"], "start": s["start"], "end": s["end"], "person": s.get("match")}
                 for s in out.get("identification", [])]
    else:
        out = _pya_job(_pya("POST", "/diarize", {"url": url, "model": model, "exclusive": True})["jobId"])
        turns = [{"speaker": s["speaker"], "start": s["start"], "end": s["end"]} for s in out.get("diarization", [])]
    return {"turns": turns, "raw": {k: v for k, v in out.items() if k != "identification"},
            "cost_usd": PYA_PER_HOUR_EUR.get(model, 0.112) * 1.08 * item["duration"] / 3600}
