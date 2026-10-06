#!/usr/bin/env python3
# Run variants x scenarios x reps through packages/cli/scripts/prompt-dry-run.ts --call,
# then grade. Usage: run.py <round> <model> <reps> <variant,...> [scenario,...]
import json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from scenarios import SCENARIOS, ORG, WHO, LIVE, TOOLS, FORMAT

HERE = os.path.dirname(os.path.abspath(__file__))
HOME_DIR = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))

def live_messaging():
    """The messaging guidance every agent reads, from the snippet catalog itself."""
    src = open(os.path.join(REPO, "packages/shared/contracts/snippets.ts")).read()
    body = re.search(r"export const MESSAGING_SNIPPET = `(.*?)`;", src, re.S).group(1)
    return body.replace("\\`", "`").strip()
HARNESS = os.path.join(REPO, "packages/cli/scripts/prompt-dry-run.ts")
MESSAGING = live_messaging()
PAR = int(os.environ.get("PAR", "6"))

def system_for(variant, who):
    guidance = open(f"{HERE}/variants/{variant}.md").read().strip()
    block = f"<org-context>\n{ORG}\n\n{WHO[who]}\n{LIVE}\n" + (f"\n{guidance}\n" if guidance else "") + "</org-context>"
    return ("You are an AI agent session working inside codecast, a system where many agent sessions and a few people work together. "
            "The instructions below are part of your standing context.\n\n" + MESSAGING + "\n\n" + block)

def one(job):
    rnd, model, v, sc, rep = job
    d = f"{HOME_DIR}/suite-runs/{rnd}/{v}/{sc['id']}/{rep}"
    if os.path.exists(f"{d}/graded.json"): return json.load(open(f"{d}/graded.json"))
    os.makedirs(d, exist_ok=True)
    subprocess.run(["rm", "-rf", f"{d}/h"])
    open(f"{d}/system.md", "w").write(system_for(v, sc["who"]))
    open(f"{d}/prompt.md", "w").write(f"{sc['situation']}\n\n{TOOLS}\n\n{FORMAT}")
    subprocess.run(["bun", HARNESS, "--run", f"{d}/h", "--prompt", f"{d}/prompt.md", "--system", f"{d}/system.md", "--model", model, "--call", "--max-output-tokens", "4000", "--account", os.environ.get("ACCOUNT", "claude7")],
                   stdout=subprocess.DEVNULL, stderr=open(f"{d}/err.txt", "w"), timeout=900)
    reply = open(f"{d}/h/reply.txt").read() if os.path.exists(f"{d}/h/reply.txt") else ""
    m = re.search(r"\{.*\}", reply, re.S)
    try: parsed = json.loads(m.group(0)) if m else None
    except Exception: parsed = None
    score = sc["grade"](parsed) if parsed else None
    out = {"round": rnd, "variant": v, "scenario": sc["id"], "rep": rep, "score": score, "parsed": parsed,
           "interrupts": len([a for a in (parsed or {}).get("actions", []) if a.get("type") in ("send", "role_wake", "decide", "chat")])}
    if parsed is not None: json.dump(out, open(f"{d}/graded.json", "w"))
    return out

if __name__ == "__main__":
    rnd, model, reps, variants = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4].split(",")
    only = set(sys.argv[5].split(",")) if len(sys.argv) > 5 else None
    jobs = [(rnd, model, v, sc, r) for r in range(reps) for v in variants for sc in SCENARIOS if not only or sc["id"] in only]
    with ThreadPoolExecutor(PAR) as ex:
        res = list(ex.map(one, jobs))
    json.dump(res, open(f"{HOME_DIR}/suite-runs/{rnd}/results.json", "w"), indent=1)
    print("done", len(res), "unparsed", sum(r["score"] is None for r in res))
