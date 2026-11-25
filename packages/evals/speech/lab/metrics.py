"""Scores for one hypothesis against one item.

wer      words only, speakers ignored (both sides read in time order)
cpwer    concatenated minimum-permutation WER (meeteval): words AND who said them,
         with the best one-to-one map from the stack's speakers to the reference
der      diarization error rate (pyannote.metrics), overlap counted, with a collar
named    the product metric: of the reference words, the share the stack put on
         the RIGHT PERSON by name, the share on a wrong person (worst: a confident
         wrong name), the share left unnamed, and the share no line covered
"""
from __future__ import annotations

from collections import Counter

from common import norm_words


def _ref_word_times(seg):
    if seg.get("words"):
        return [((w[1] + w[2]) / 2, w[0]) for w in seg["words"]]
    ws = seg["text"].split()
    if not ws:
        return []
    span = max(seg["end"] - seg["start"], 1e-3)
    return [(seg["start"] + span * (i + 0.5) / len(ws), w) for i, w in enumerate(ws)]


def wer(ref_segs, hyp_segs):
    import jiwer
    r = " ".join(" ".join(norm_words(s["text"])) for s in sorted(ref_segs, key=lambda s: s["start"]))
    h = " ".join(" ".join(norm_words(s["text"])) for s in sorted(hyp_segs, key=lambda s: s["start"]))
    if not r:
        return None
    o = jiwer.process_words(r, h or "")
    n = o.hits + o.substitutions + o.deletions
    return {"wer": (o.substitutions + o.deletions + o.insertions) / n, "sub": o.substitutions / n,
            "del": o.deletions / n, "ins": o.insertions / n, "ref_words": n}


def cpwer(ref_segs, hyp_segs, hyp_key="speaker"):
    from meeteval.wer import cp_word_error_rate
    def by(segs, key):
        out = {}
        for s in sorted(segs, key=lambda s: s["start"]):
            out.setdefault(str(s.get(key) or "?"), []).append(" ".join(norm_words(s["text"])))
        return {k: " ".join(v) for k, v in out.items()}
    r = by(ref_segs, "person")
    h = by(hyp_segs, hyp_key) or {"?": ""}
    if len(h) > 2 * len(r) + 4:  # meeteval refuses huge speaker counts; keep the biggest, fold the rest
        keep = sorted(h, key=lambda k: -len(h[k]))[:2 * len(r) + 3]
        h = {k: v for k, v in h.items() if k in keep} | {"rest": " ".join(v for k, v in h.items() if k not in keep)}
    e = cp_word_error_rate(r, h)
    return {"cpwer": float(e.error_rate), "ref_words": e.length}


def der(ref_segs, hyp_segs, collar=0.25, uem_end=None):
    from pyannote.core import Annotation, Segment, Timeline
    from pyannote.metrics.diarization import DiarizationErrorRate
    R, H = Annotation(), Annotation()
    for i, s in enumerate(ref_segs):
        if s["end"] > s["start"]:
            R[Segment(s["start"], s["end"]), i] = str(s["person"])
    for i, s in enumerate(hyp_segs):
        if s["end"] > s["start"]:
            H[Segment(s["start"], s["end"]), i] = str(s.get("speaker"))
    m = DiarizationErrorRate(collar=collar, skip_overlap=False)
    uem = Timeline([Segment(0, uem_end)]) if uem_end else None
    d = m(R, H, detailed=True, uem=uem)
    tot = d["total"] or 1
    return {"der": d["diarization error rate"], "miss": d["missed detection"] / tot,
            "fa": d["false alarm"] / tot, "conf": d["confusion"] / tot}


def named(ref_segs, hyp_segs):
    """Word-level named-speaker accuracy over reference words."""
    hs = sorted(hyp_segs, key=lambda s: s["start"])
    c = Counter()
    per = {}
    for seg in ref_segs:
        for t, _ in _ref_word_times(seg):
            cover = [h for h in hs if h["start"] - 0.15 <= t <= h["end"] + 0.15]
            if not cover:
                k = "missed"
            elif any(h.get("person") == seg["person"] for h in cover):
                k = "right"
            elif any(h.get("person") for h in cover):
                k = "wrong"
            else:
                k = "unnamed"
            c[k] += 1
            per.setdefault(seg["person"], Counter())[k] += 1
    n = sum(c.values()) or 1
    return {"right": c["right"] / n, "wrong": c["wrong"] / n, "unnamed": c["unnamed"] / n,
            "missed": c["missed"] / n, "words": n,
            "by_person": {p: {k: v / max(1, sum(cc.values())) for k, v in cc.items()} for p, cc in per.items()}}


def attribution(ref_segs, hyp_segs, window=1.0):
    """Of the words the transcript prints that match a reference word (same word, within `window`
    seconds), the share carrying the right person, a wrong person, or no name."""
    import bisect
    refw = []
    for seg in ref_segs:
        for t, w in _ref_word_times(seg):
            for nw in norm_words(w):
                refw.append((t, nw, seg["person"]))
    refw.sort()
    times = [r[0] for r in refw]
    used = [False] * len(refw)
    c = Counter()
    hw = 0
    for seg in sorted(hyp_segs, key=lambda s: s["start"]):
        words = seg.get("words") or [[w, seg["start"], seg["end"]] for w in seg["text"].split()]
        for (w, a, b) in words:
            for nw in norm_words(w):
                hw += 1
                t = (a + b) / 2
                lo, hi = bisect.bisect_left(times, t - window), bisect.bisect_right(times, t + window)
                best = None
                for k in range(lo, hi):
                    if not used[k] and refw[k][1] == nw and (best is None or abs(times[k] - t) < abs(times[best] - t)):
                        best = k
                if best is None:
                    continue
                used[best] = True
                p = seg.get("person")
                c["right" if p == refw[best][2] else ("wrong" if p else "unnamed")] += 1
    n = sum(c.values()) or 1
    return {"attr_right": c["right"] / n, "attr_wrong": c["wrong"] / n, "attr_unnamed": c["unnamed"] / n,
            "attr_matched": n / max(1, hw)}


def score(item, hyp, collar=None):
    ref = item["ref"]
    segs = hyp["segments"]
    collar = collar if collar is not None else (0.25 if item.get("ref_quality") == "gold" else 0.5)
    out = {"item": item["id"], "set": item["set"], "minutes": item["duration"] / 60}
    if any(s.get("text") for s in segs):
        out.update(wer(ref, segs) or {})
    has_words = any(s.get("text") for s in segs)
    if any(s.get("speaker") is not None for s in segs):
        if has_words:
            out.update(cpwer(ref, segs))
        out.update(der(ref, segs, collar=collar, uem_end=item["duration"]))
    if any(s.get("person") for s in segs):
        nm = named(ref, segs)
        out.update({f"named_{k}": v for k, v in nm.items() if k != "by_person"})
        out["named_by_person"] = nm["by_person"]
        if has_words:
            out["named_cpwer"] = cpwer(ref, segs, hyp_key="person")["cpwer"]
            out.update(attribution(ref, segs))
    out["cost_usd"] = hyp.get("cost_usd", 0.0)
    out["seconds"] = hyp.get("seconds")
    return out
