"""Export what production's naming step needs to reproduce the lab, per item:
the Scribe turns, the clean windows chosen per speaker, each window's CAM++ vector,
each enrolled person's vectors, and the names the lab's matcher gave.

  python export_fixture.py <out_dir> <item> [<item> ...]   [--threshold 0.4 --margin 0.05]

Real meetings' vectors stay under SPEECH_LAB_HOME; only AMI items (CC BY 4.0) may be
copied into a repo test, and only as vectors, never audio.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import identify as id_mod
from asr import cached
from common import item_by_id
from lab import enrollment_sources, siblings_of


def r4(v):
    return [round(float(x), 4) for x in v]


def export(item_id, threshold, margin, drop=None):
    item = item_by_id(item_id)
    A = cached("asr-scribe_v3", item, lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("no cached Scribe run")),
               language="en", model="scribe_v3")
    turns = A["turns"]
    enroll = "headset" if item["set"] == "ami" else "room"
    sources = enrollment_sources(item, enroll, siblings_of(item), drop)
    prints = id_mod.enroll("campplus", sources, 60)
    wins = id_mod.clean_windows(turns, "speaker")
    clusters = {}
    for spk, ws in wins.items():
        ws = id_mod._budget(ws, 90.0)
        clusters[spk] = [{"start": a, "end": b, "vector": r4(id_mod.embed("campplus", item["audio"], a, b))} for (a, b) in ws]
    import numpy as np
    cl_np = {k: np.array([w["vector"] for w in v], dtype=np.float32) for k, v in clusters.items() if v}
    names, scores = id_mod.match(cl_np, prints, threshold, margin, "centroid", None)
    return {
        "item": item_id, "set": item["set"], "threshold": threshold, "margin": margin, "drop": drop,
        "turns": turns,
        "clusters": clusters,
        "prints": {p: [r4(v) for v in vs] for p, vs in prints.items()},
        "expected": {k: v for k, v in names.items()},
        "scores": scores,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("items", nargs="+")
    ap.add_argument("--threshold", type=float, default=0.4)
    ap.add_argument("--margin", type=float, default=0.05)
    ap.add_argument("--drop", type=int)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for i in a.items:
        d = export(i, a.threshold, a.margin, a.drop)
        suffix = f"-drop{a.drop}" if a.drop is not None else ""
        (out / f"{i}{suffix}.json").write_text(json.dumps(d))
        print(i, {k: v for k, v in d["expected"].items()}, "clusters", {k: len(v) for k, v in d["clusters"].items()})
