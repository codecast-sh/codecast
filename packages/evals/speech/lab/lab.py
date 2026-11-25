"""Speech lab: run a stack over a labeled set and score it.

  python lab.py run  <set> <stack> [--items a,b] [--name run_name]
  python lab.py show <run> [<run> ...]          # table of scores, set means weighted by minutes

A stack is "asr=<name>[:k=v...],diar=<name>[:k=v...],id=<name>[:k=v...]", any part optional:
  asr   parakeet | whisper-1 | gpt-transcribe | scribe_v3 | ...
  diar  sherpa[:embed=campplus:threshold=0.5] | oracle | pyannoteai | none
  id    voiceprint[:model=campplus:threshold=0.5:margin=0.05:enroll=headset|room:seconds=60] | none
Words are put on the diarizer's speaker whose turn covers them most, consecutive words of one
speaker become a line, and identification names each speaker or leaves it unnamed.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

import asr as asr_mod
import diarize as diar_mod
import identify as id_mod
from common import ITEMS, RUNS, item_by_id, items_of, read_json, write_json
from metrics import score


def parse_stack(spec):
    parts = {}
    for chunk in spec.split(","):
        k, _, rest = chunk.partition("=")
        name, *kvs = rest.split(":")
        params = {}
        for kv in kvs:
            a, _, b = kv.partition("=")
            try:
                b = int(b) if b.lstrip("-").isdigit() else float(b)
            except ValueError:
                pass
            params[a] = b
        parts[k] = (name, params)
    return parts


def words_to_lines(words, turns, gap=1.2):
    ts = sorted(turns, key=lambda t: t["start"])
    lines, cur = [], None
    for (w, s, e) in words:
        best, bo = None, 0.0
        for t in ts:
            if t["start"] > e + 0.5:
                break
            o = min(e, t["end"]) - max(s, t["start"])
            if o > bo:
                best, bo = t["speaker"], o
        if best is None:
            mid = (s + e) / 2
            near = [t for t in ts if abs((t["start"] + t["end"]) / 2 - mid) < 30]
            if near:
                t = min(near, key=lambda t: min(abs(t["start"] - mid), abs(t["end"] - mid)))
                if min(abs(t["start"] - mid), abs(t["end"] - mid)) < 0.5:
                    best = t["speaker"]
        if cur and cur["speaker"] == best and s - cur["end"] <= gap:
            cur["words"].append([w, s, e])
            cur["end"] = e
        else:
            if cur:
                lines.append(cur)
            cur = {"speaker": best, "start": s, "end": e, "words": [[w, s, e]]}
    if cur:
        lines.append(cur)
    for l in lines:
        l["text"] = " ".join(w[0] for w in l["words"])
    return lines


def words_to_lines_activity(words, activity, gap=1.2, floor=0.15):
    """Each word goes to the label with the most averaged frame activity over the word's span
    (a hair wider than the word), ties and silence to the previous word's label."""
    hop = activity["hop"]
    labs = list(activity["labels"])
    A = [activity["labels"][l] for l in labs]
    n = len(A[0]) if A else 0
    lines, cur, prev = [], None, None
    for (w, s, e) in words:
        a, b = max(0, int((s - 0.05) / hop)), min(n, int((e + 0.05) / hop) + 1)
        best, bv = prev, floor
        for li, arr in enumerate(A):
            if b > a:
                v = sum(arr[a:b]) / (b - a)
                if v > bv:
                    best, bv = labs[li], v
        prev = best
        if cur and cur["speaker"] == best and s - cur["end"] <= gap:
            cur["words"].append([w, s, e]); cur["end"] = e
        else:
            if cur:
                lines.append(cur)
            cur = {"speaker": best, "start": s, "end": e, "words": [[w, s, e]]}
    if cur:
        lines.append(cur)
    for l in lines:
        l["text"] = " ".join(x[0] for x in l["words"])
    return lines


def enrollment_sources(item, mode, siblings, drop=None):
    """People's clean speech from OTHER items that share them. `drop` (an index into the item's
    sorted people) leaves one person unenrolled: the open-set test, where they must stay unnamed."""
    src = defaultdict(list)
    dropped = sorted(item["people"])[int(drop)] if drop is not None else None
    for other in siblings:
        if other["id"] == item["id"]:
            continue
        turns = [{"speaker": s["person"], "start": s["start"], "end": s["end"]} for s in other["ref"]]
        wins = id_mod.clean_windows(turns, "speaker", min_len=1.5)
        for person, ws in wins.items():
            if person not in item["people"] or person == dropped:
                continue
            path = other.get("headsets", {}).get(person) if mode == "headset" else other["audio"]
            if path:
                src[person] += [(path, a, b) for (a, b) in ws]
    return dict(src)


def siblings_of(item):
    if item["set"] == "ami":
        return [i for i in items_of("ami") if i.get("series") == item.get("series")]
    return items_of(item["set"])


def run_item(item, stack):
    hyp = {"cost_usd": 0.0, "seconds": 0.0, "meta": {}}
    a = stack.get("asr")
    d = stack.get("diar", ("none", {}))
    i = stack.get("id", ("none", {}))
    words = None
    if a:
        A = asr_mod.run(item, a[0], **a[1])
        hyp["cost_usd"] += A.get("cost_usd", 0)
        hyp["seconds"] += A.get("seconds", 0)
        words = A.get("words")
        asr_segments = A["segments"]
    turns = None
    idp = {"model": "campplus", "threshold": 0.5, "margin": 0.05, "enroll": "room", "seconds": 60,
           "how": "centroid", "reuse": None, **i[1]}
    if d[0] == "vdiar":
        import vdiar
        from asr import cached
        enrolled = i[0] == "voiceprint"
        def _vd(item, enroll=None, seconds=None, model=None, v=None, words=None, drop=None, **kw):
            prints = None
            if enrolled:
                prints = id_mod.enroll(idp["model"], enrollment_sources(item, idp["enroll"], siblings_of(item), idp.get("drop")), idp["seconds"])
            out = vdiar.run(item, prints, model=model, **kw)
            return {"turns": out["turns"], "activity": out.get("activity"), "meta": out["meta"], "cost_usd": 0.0}
        D = cached("diar-vdiar", item, _vd, **d[1], v=vdiar.VERSION, enroll=idp["enroll"] if enrolled else "none", seconds=idp["seconds"] if enrolled else None, model=idp["model"], drop=idp.get("drop"))
        turns = D["turns"]
        activity = D.get("activity")
        hyp["seconds"] += D.get("seconds", 0)
        hyp["meta"]["vdiar"] = D.get("meta")
        i = ("vdiar", {})
    elif d[0] == "scribe":
        turns = A["turns"]
    elif d[0] == "pyannoteai" and i[0] == "vendor":
        from asr import cached
        import vendors
        def _pi(item, enroll=None, model="precision-2", threshold=50, exclusive=1):
            srcs = enrollment_sources(item, enroll, siblings_of(item))
            vps = {}
            for person, clips in srcs.items():
                key = f"vp-{enroll}-{item['id']}-{person}"
                vps[person] = cached("pya-voiceprint", {"id": key}, lambda _it, c=clips: {"vp": vendors.pyannote_voiceprint(c)})["vp"]
            return vendors.pyannoteai_diarize(item, model=model, voiceprints=vps, threshold=threshold, exclusive=exclusive)
        D = cached("diar-pyannoteai-identify", item, _pi, enroll=i[1].get("enroll", "room"), **d[1])
        turns = D["turns"]
        hyp["cost_usd"] += D.get("cost_usd", 0)
        hyp["seconds"] += D.get("seconds", 0)
    elif d[0] != "none":
        D = diar_mod.run(item, d[0], **d[1])
        turns = D["turns"]
        hyp["cost_usd"] += D.get("cost_usd", 0)
        hyp["seconds"] += D.get("seconds", 0)
    if turns is not None and words and d[0] == "vdiar" and d[1].get("words") == "activity" and activity:
        lines = words_to_lines_activity(words, activity)
    elif turns is not None and words:
        lines = words_to_lines(words, turns)
    elif turns is not None and not a:
        lines = [{**t, "text": ""} for t in turns]
    else:
        lines = [{"speaker": None, **s} for s in asr_segments]
    names = {}
    if i[0] == "voiceprint" and turns is not None:
        p = idp
        sources = enrollment_sources(item, p["enroll"], siblings_of(item), p.get("drop"))
        prints = id_mod.enroll(p["model"], sources, p["seconds"])
        clusters = id_mod.cluster_prints(p["model"], item["audio"], turns)
        names, scores = id_mod.match(clusters, prints, p["threshold"], p["margin"], p["how"], p["reuse"])
        hyp["meta"]["id_scores"] = scores
        hyp["meta"]["enrolled"] = {k: int(v.shape[0]) for k, v in prints.items()}
    elif i[0] == "vdiar":
        names = {t["speaker"]: t.get("person") for t in turns}
    elif i[0] == "vendor":
        names = {}
        for t in turns or []:
            if t.get("person"):
                names[t["speaker"]] = t["person"]
    for l in lines:
        l["person"] = names.get(l["speaker"]) if names else l.get("person")
    hyp["segments"] = lines
    hyp["meta"]["names"] = names
    return hyp


def cmd_run(args):
    stack = parse_stack(args.stack)
    items = [item_by_id(x) for x in args.items.split(",")] if args.items else items_of(args.set)
    name = args.name or (args.set + "__" + args.stack.replace(",", "__").replace(":", "_").replace("=", "-"))
    rows = []
    for it in items:
        try:
            hyp = run_item(it, stack)
        except Exception as e:  # keep the run going; report the item
            print(f"{it['id']}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
            continue
        write_json(RUNS / name / "hyp" / f"{it['id']}.json", hyp)
        s = score(it, hyp)
        rows.append(s)
        print(fmt_row(s))
    write_json(RUNS / name / "scores.json", {"stack": args.stack, "rows": rows})
    print(fmt_row(summarize(rows), label=f"== {name}"))


COLS = [("wer", "WER"), ("cpwer", "cpWER"), ("der", "DER"), ("conf", "conf"), ("named_right", "named"),
        ("named_wrong", "wrong"), ("named_unnamed", "unnamed"), ("named_cpwer", "n-cpWER"),
        ("attr_right", "w-right"), ("attr_wrong", "w-wrong"), ("cost_usd", "$")]


def summarize(rows):
    out = {"item": "mean", "minutes": sum(r["minutes"] for r in rows)}
    for k, _ in COLS:
        vals = [(r[k], r["minutes"]) for r in rows if r.get(k) is not None]
        if vals:
            out[k] = sum(v * m for v, m in vals) / sum(m for _, m in vals) if k != "cost_usd" else sum(v for v, _ in vals)
    return out


def fmt_row(r, label=None):
    cells = [f"{(label or r['item']):<34}", f"{r['minutes']:6.1f}m"]
    for k, h in COLS:
        v = r.get(k)
        cells.append(f"{h}={'—' if v is None else (f'{v:.3f}' if k == 'cost_usd' else f'{100*v:5.1f}')}")
    return "  ".join(cells)


def cmd_show(args):
    for name in args.runs:
        s = read_json(RUNS / name / "scores.json")
        print(fmt_row(summarize(s["rows"]), label=name[:34]))
        if args.items:
            for r in s["rows"]:
                print("   ", fmt_row(r))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("set")
    r.add_argument("stack")
    r.add_argument("--items")
    r.add_argument("--name")
    s = sub.add_parser("show")
    s.add_argument("runs", nargs="+")
    s.add_argument("--items", action="store_true")
    a = ap.parse_args()
    {"run": cmd_run, "show": cmd_show}[a.cmd](a)
