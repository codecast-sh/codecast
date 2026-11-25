"""Shared paths, item/hypothesis formats and audio helpers for the speech lab.

An ITEM is one labeled recording:
  {id, set, audio, duration,
   people: {person_id: name},
   ref: [{person, start, end, text, words: [[w, s, e], ...]}],   # file seconds
   enroll_from: [item ids whose audio may enroll these people]}

A HYPOTHESIS is what a stack returns for an item:
  {segments: [{speaker, person, start, end, text, words?}], cost_usd, seconds, meta}
`speaker` is the stack's own cluster label; `person` is a person id when the
stack identified one, else null.

Real audio and labels never enter git: everything lives under SPEECH_LAB_HOME.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

HOME = Path(os.environ.get("SPEECH_LAB_HOME", Path.home() / ".codecast" / "diarize-lab"))
ITEMS = HOME / "items"
RUNS = HOME / "runs"
CACHE = HOME / "cache"
MODELS = HOME / "models"
for d in (ITEMS, RUNS, CACHE, MODELS):
    d.mkdir(parents=True, exist_ok=True)


def read_json(p):
    with open(p) as f:
        return json.load(f)


def write_json(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    tmp.replace(p)


def items_of(set_name: str):
    d = ITEMS / set_name
    return [read_json(p) for p in sorted(d.glob("*.json"))]


def item_by_id(item_id: str):
    for p in ITEMS.glob(f"*/{item_id}.json"):
        return read_json(p)
    raise KeyError(item_id)


def to_wav16k(src: str | Path, dst: str | Path, start: float | None = None, end: float | None = None):
    args = ["ffmpeg", "-loglevel", "error", "-y"]
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    if end is not None:
        args += ["-to", f"{end:.3f}"]
    args += ["-i", str(src), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)]
    subprocess.run(args, check=True)
    return Path(dst)


def to_mp3(src, dst, kbps=64):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000",
                    "-b:a", f"{kbps}k", str(dst)], check=True)
    return Path(dst)


def read_wav(path):
    import soundfile as sf
    audio, sr = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    assert sr == 16000, f"{path} is {sr} Hz; build items at 16 kHz"
    return audio


FILLERS = {"um", "uh", "hmm", "mm", "mhm", "mm-hmm", "uh-huh", "ah", "er", "erm", "eh", "hm", "uhm", "mmm", "huh"}
_SPELL = {"ok": "okay", "yeah": "yeah", "yep": "yeah", "ya": "yeah", "yea": "yeah", "alright": "all right",
          "gonna": "going to", "wanna": "want to", "kinda": "kind of", "sorta": "sort of"}


def norm_words(text: str) -> list[str]:
    """Scoring normalizer: case, punctuation, fillers and a few spellings out."""
    t = text.lower().replace("’", "'")
    t = re.sub(r"[^\w\s'-]", " ", t)
    t = t.replace("-", " ")
    out = []
    for w in t.split():
        w = w.strip("'")
        if not w or w in FILLERS:
            continue
        w = _SPELL.get(w, w)
        out.extend(w.split())
    return out
