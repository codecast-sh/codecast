import os
HOME_DIR = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
#!/usr/bin/env python3
# Score table for a round: per variant mean score, per scenario breakdown, interrupts.
import json, sys, collections
rnd = sys.argv[1]
R = [r for r in json.load(open(os.path.join(HOME_DIR,'suite-runs',rnd,'results.json'))) if r["score"] is not None]
variants = sorted({r["variant"] for r in R}, key=lambda v: "NABCDEH".find(v[0]) * 100 + len(v))
scen = list(dict.fromkeys(r["scenario"] for r in R))
cell = collections.defaultdict(list); intr = collections.defaultdict(list)
for r in R:
    cell[(r["variant"], r["scenario"])].append(r["score"]); intr[r["variant"]].append(r["interrupts"])
print(f"{'scenario':16}" + "".join(f"{v:>7}" for v in variants))
for s in scen:
    print(f"{s:16}" + "".join(f"{sum(cell[(v,s)])/max(1,len(cell[(v,s)])):7.2f}" for v in variants))
tot = {v: [x for s in scen for x in cell[(v, s)]] for v in variants}
print(f"{'MEAN (of 2)':16}" + "".join(f"{sum(tot[v])/len(tot[v]):7.2f}" for v in variants))
print(f"{'interrupts/call':16}" + "".join(f"{sum(intr[v])/len(intr[v]):7.2f}" for v in variants))
print(f"{'n':16}" + "".join(f"{len(tot[v]):7d}" for v in variants))
