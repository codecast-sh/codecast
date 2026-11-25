"""Build labeled items.

ami    AMI meetings: far-field Array1-01 mic as the input (one room mic, like a
       phone on the table), the manual word-level transcript per speaker as the
       reference, and each speaker's own headset as a clean enrollment source
       (like a teammate's own huddle track). Speakers keep their AMI global id
       across a series, so ES2004a can enroll people that ES2004b-d are scored on.
calls  Our own huddles that were recorded: the composite file is the input and
       each line's per-track attribution is the speaker truth. The words are the
       live recognizer's, so WER against them is "silver"; speaker truth is exact
       up to the line timing, which calibrate_calls() fits against the audio.
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from common import HOME, ITEMS, read_json, to_wav16k, write_json

AMI = HOME / "ami"
NITE = "{http://nite.sourceforge.net/}"


def _ami_speakers(meeting: str):
    meetings = ET.parse(AMI / "manual" / "corpusResources" / "meetings.xml").getroot()
    for m in meetings:
        if m.get("observation") == meeting:
            return {s.get("nxt_agent"): (s.get("global_name"), int(s.get("channel"))) for s in m}
    raise KeyError(meeting)


def _ami_words(meeting: str, agent: str):
    root = ET.parse(AMI / "manual" / "words" / f"{meeting}.{agent}.words.xml").getroot()
    out = []
    for el in root:
        if el.tag != "w" or el.get("punc") == "true":
            continue
        s, e = el.get("starttime"), el.get("endtime")
        if s is None or e is None or not (el.text or "").strip():
            continue
        out.append([el.text.strip(), float(s), float(e)])
    return out


def segments_from_words(person, words, gap=0.6):
    segs, cur = [], None
    for w in words:
        if cur and w[1] - cur["end"] <= gap:
            cur["words"].append(w)
            cur["end"] = max(cur["end"], w[2])
        else:
            if cur:
                segs.append(cur)
            cur = {"person": person, "start": w[1], "end": w[2], "words": [w]}
    if cur:
        segs.append(cur)
    for s in segs:
        s["text"] = " ".join(w[0] for w in s["words"])
    return segs


def build_ami(meetings):
    import soundfile as sf
    for m in meetings:
        src = AMI / m / f"{m}.Array1-01.wav"
        if not src.exists():
            print("missing", src)
            continue
        dst = AMI / m / f"{m}.sdm16k.wav"
        if not dst.exists():
            to_wav16k(src, dst)
        spk = _ami_speakers(m)
        ref, people, headsets = [], {}, {}
        for agent, (gid, ch) in spk.items():
            people[gid] = gid
            ref += segments_from_words(gid, _ami_words(m, agent))
            hs = AMI / m / f"{m}.Headset-{ch}.wav"
            if hs.exists():
                hs16 = AMI / m / f"{m}.Headset-{ch}.16k.wav"
                if not hs16.exists():
                    to_wav16k(hs, hs16)
                headsets[gid] = str(hs16)
        ref.sort(key=lambda s: s["start"])
        series = re.sub(r"[a-d]$", "", m)
        write_json(ITEMS / "ami" / f"{m}.json", {
            "id": m, "set": "ami", "series": series, "audio": str(dst),
            "duration": sf.info(str(dst)).duration, "people": people, "ref": ref,
            "ref_quality": "gold", "headsets": headsets,
        })
        print("ami", m, len(ref), "segments", len(people), "people")


def build_calls(call_ids, lab_calls=HOME / "calls"):
    import soundfile as sf
    for c in call_ids:
        d = lab_calls / c
        call = read_json(d / "call.json")
        recs = read_json(d / "recordings.json")["recordings"]
        comps = [r for r in recs if r["kind"] == "composite" and r.get("started_at")]
        for i, r in enumerate(recs):
            if r not in comps:
                continue
            wav = d / f"composite{i}.wav"
            if not wav.exists():
                print("missing", wav)
                continue
            dur = sf.info(str(wav)).duration
            off = (call["started_at"] - r["started_at"]) / 1000.0
            ref, people = [], {}
            for s in call["segments"]:
                st, en = off + s["t0"] / 1000.0, off + s["t1"] / 1000.0
                if en <= 0 or st >= dur or not s["text"].strip():
                    continue
                people[s["speaker_id"]] = s["speaker_name"]
                ref.append({"person": s["speaker_id"], "start": max(0.0, st), "end": min(dur, en),
                            "raw_start": st, "raw_end": en, "text": s["text"].strip(), "seq": s["seq"]})
            item_id = f"{c}-{i}"
            write_json(ITEMS / "calls" / f"{item_id}.json", {
                "id": item_id, "set": "calls", "call": c, "audio": str(wav), "duration": dur,
                "people": people, "ref": ref, "ref_quality": "silver", "timing": "raw",
            })
            print("calls", item_id, f"{dur/60:.1f} min", len(ref), "lines", sorted(people.values()))




def calibrate_calls(item_ids=None):
    """Fit each call's line timing to its audio. A line's t0 is when the recognizer saw speech
    start and its t1 when the words came back, so lines sit late and run long. Pick the start
    shift and end trim that best match a VAD speech mask (frame F1), apply them, then clip
    each line to the speech inside it."""
    import numpy as np
    from asr import vad_regions
    from common import items_of, read_wav
    for it in items_of("calls"):
        if item_ids and it["id"] not in item_ids:
            continue
        audio = read_wav(it["audio"])
        fr = 0.02
        n = int(len(audio) / 16000 / fr) + 1
        vad = np.zeros(n, bool)
        regions = vad_regions(audio, max_len=30, min_silence=0.25, threshold=0.4)
        for a, b in regions:
            vad[int(a / fr):int(b / fr)] = True
        best = None
        for a in np.arange(-30.0, 6.01, 0.1):
            for b in np.arange(-3.0, 3.01, 0.2):
                m = np.zeros(n, bool)
                for s in it["ref"]:
                    x, y = s["raw_start"] + a, s["raw_end"] - b
                    if y > x:
                        m[max(0, int(x / fr)):max(0, int(y / fr))] = True
                tp = (m & vad).sum()
                f1 = 2 * tp / (m.sum() + vad.sum() + 1e-9)
                if best is None or f1 > best[0]:
                    best = (f1, a, b)
        f1, a, b = best
        for s in it["ref"]:
            x, y = max(0.0, s["raw_start"] + a), min(it["duration"], s["raw_end"] - b)
            if y <= x:
                y = x + 0.3
            inside = [(max(x, p), min(y, q)) for p, q in regions if q > x and p < y]
            if inside:
                x, y = min(p for p, _ in inside), max(q for _, q in inside)
            s["start"], s["end"] = x, y
        it["timing"] = {"shift": round(float(a), 2), "trim": round(float(b), 2), "f1": round(float(f1), 3)}
        write_json(ITEMS / "calls" / f"{it['id']}.json", it)
        print(it["id"], it["timing"])

def align_calls(item_ids=None, words_run="asr-whisper-1-chunk_min=5-language=en-model=whisper-1"):
    """Anchor each call's lines to the audio by their words. A word-timestamped transcript of the
    composite (any decent recognizer) gives where words are; the global offset is the shift that
    lines the most label words up with equal transcript words, and each line then takes the span
    of the transcript words it matches. Lines with too few matches keep the shifted raw span."""
    import difflib
    import numpy as np
    from common import CACHE, items_of, norm_words, read_json
    for it in items_of("calls"):
        if item_ids and it["id"] not in item_ids:
            continue
        W = read_json(CACHE / words_run / f"{it['id']}.json")["words"]
        hw = [(nw, (w[1] + w[2]) / 2, w[1], w[2]) for w in W for nw in norm_words(w[0])[:1]]
        times = np.array([h[1] for h in hw])
        by_word = {}
        for i, h in enumerate(hw):
            by_word.setdefault(h[0], []).append(h[1])
        by_word = {k: np.array(v) for k, v in by_word.items()}
        best = (-1, 0.0)
        for sh in np.arange(-40.0, 10.01, 0.25):
            hits = 0
            for s in it["ref"]:
                ws = norm_words(s["text"])
                span = max(0.3, s["raw_end"] - s["raw_start"])
                for k, w in enumerate(ws):
                    t = s["raw_start"] + sh + span * (k + 0.5) / len(ws)
                    arr = by_word.get(w)
                    if arr is not None and np.any(np.abs(arr - t) < 1.5):
                        hits += 1
            if hits > best[0]:
                best = (hits, float(sh))
        sh = best[1]
        anchored = 0
        for s in it["ref"]:
            ws = norm_words(s["text"])
            a, b = s["raw_start"] + sh - 3, s["raw_end"] + sh + 3
            idx = [i for i, h in enumerate(hw) if a <= h[1] <= b]
            win = [hw[i][0] for i in idx]
            sm = difflib.SequenceMatcher(a=ws, b=win, autojunk=False)
            m = [(blk.b, blk.size) for blk in sm.get_matching_blocks() if blk.size]
            matched = [idx[j + k] for (j, n) in m for k in range(n)]
            if ws and (len(matched) >= max(2, 0.5 * len(ws)) or (len(ws) <= 2 and len(matched) == len(ws))):
                s["start"], s["end"] = hw[matched[0]][2], hw[matched[-1]][3]
                s["anchored"] = True
                anchored += 1
            else:
                s["start"], s["end"] = max(0.0, s["raw_start"] + sh), max(0.0, s["raw_end"] + sh - 0.8)
                s["anchored"] = False
            if s["end"] <= s["start"]:
                s["end"] = s["start"] + 0.3
        it["timing"] = {"shift": sh, "word_hits": best[0], "anchored": anchored, "lines": len(it["ref"])}
        write_json(ITEMS / "calls" / f"{it['id']}.json", it)
        print(it["id"], it["timing"])


if __name__ == "__main__":
    import sys
    kind, *ids = sys.argv[1:]
    {"ami": build_ami, "calls": build_calls, "calibrate": calibrate_calls, "align": align_calls}[kind](ids)
