"""Tune the voice-aware diarizer's cheap stage on DEV items, then report HELD items untouched.

  python sweep.py                      # grid on dev, best params scored on held
Scores per setting: DER, and the named-speaker split (right / wrong / unnamed / missed).
Objective: right - 2*wrong (a confident wrong name costs more than an honest "Speaker 2").
"""
from __future__ import annotations

import itertools
import json
import sys

import identify as id_mod
import vdiar
from common import RUNS, item_by_id, read_wav, write_json
from lab import enrollment_sources, siblings_of
from metrics import attribution, der, named
from asr import run as asr_run
from lab import words_to_lines

DEV = ["ES2004a", "ES2004b", "cl-137-0"]
HELD = ["ES2004c", "ES2004d", "cl-180-0", "cl-147-0"]
GRID = {
    "accept": [0.4, 0.5],
    "margin": [0.05],
    "accept_cluster": [0.45, 0.55, 0.65],
    "merge_unknown": [0.5, 0.65],
    "self_ref": [0, 1],
    "onset": [0.35],
    "fold_units": [4],
}
SCENARIOS = [None, 0, 2]  # everyone enrolled; one person left out (open set)
FIXED = {"cluster": 0.45, "min_off": 0.6}
WORDS = {"asr": "whisper-1", "chunk_min": 5, "language": "en"}


def prints_for(item, enroll, drop=None):
    return id_mod.enroll("campplus", enrollment_sources(item, enroll, siblings_of(item), drop), 60)


def evaluate(items, params, cache, scenarios=(None,)):
    rows = []
    for it in items:
      for drop in scenarios:
        key = (it["id"], drop)
        if key not in cache:
            enroll = "headset" if it["set"] == "ami" else "room"
            cache[key] = (None, prints_for(it, enroll, drop))
        audio, prints = cache[key]
        out = vdiar.diarize(audio, prints, cache_key=it["id"], **FIXED, **params)
        turns = out["turns"]
        words = asr_run(it, WORDS["asr"], chunk_min=WORDS["chunk_min"], language=WORDS["language"])["words"]
        lines = words_to_lines(words, turns)
        for l in lines:
            l["person"] = next((t["person"] for t in turns if t["speaker"] == l["speaker"]), None)
        at = attribution(it["ref"], lines)
        d = der(it["ref"], turns, collar=0.25 if it["ref_quality"] == "gold" else 0.5, uem_end=it["duration"])
        n = named(it["ref"], turns)
        rows.append({"item": f"{it['id']}/drop{drop}", "min": it["duration"] / 60, **d, **{k: n[k] for k in ("right", "wrong", "unnamed", "missed")}, **at})
    tot = sum(r["min"] for r in rows)
    keys = ("der", "conf", "miss", "fa", "right", "wrong", "unnamed", "missed", "attr_right", "attr_wrong", "attr_unnamed")
    mean = {k: sum(r[k] * r["min"] for r in rows) / tot for k in keys}
    mean["objective"] = mean["attr_right"] - 2 * mean["attr_wrong"]
    return mean, rows


def fmt(m):
    return " ".join(f"{k}={100*m[k]:5.1f}" for k in ("der", "conf", "attr_right", "attr_wrong", "attr_unnamed", "objective"))


if __name__ == "__main__":
    dev = [item_by_id(i) for i in DEV]
    held = [item_by_id(i) for i in HELD]
    cache = {}
    results = []
    keys = list(GRID)
    shard, nshards = (int(x) for x in (sys.argv[1].split("/") if len(sys.argv) > 1 else ("0", "1")))
    combos = list(itertools.product(*[GRID[k] for k in keys]))[shard::nshards]
    for combo in combos:
        p = dict(zip(keys, combo))
        m, _ = evaluate(dev, p, cache, SCENARIOS)
        results.append((m["objective"], p, m))
        print(json.dumps(p), fmt(m), flush=True)
    results.sort(key=lambda r: -r[0])
    if nshards > 1:
        write_json(RUNS / f"sweep_shard{shard}.json", [(o, p, m) for o, p, m in results])
        sys.exit(0)
    best = results[0][1]
    print("\nBEST on dev:", json.dumps(best), fmt(results[0][2]))
    cache_h = {}
    m, rows = evaluate(held, best, cache_h, SCENARIOS)
    print("HELD:", fmt(m))
    for r in rows:
        print("   ", r["item"], fmt({**r, "objective": r["attr_right"] - 2 * r["attr_wrong"]}))
    write_json(RUNS / "sweep_vdiar.json", {"best": best, "dev": results[0][2], "held": m, "held_rows": rows,
                                          "top": [(o, p) for o, p, _ in results[:10]]})
