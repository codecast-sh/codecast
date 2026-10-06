#!/usr/bin/env python3
# A small multi-agent world: one lead and five workers over ROUNDS rounds.
# Facts start with (or are discovered by) one agent and are NEEDED by others
# before a deadline round; some facts matter to nobody. Each round every agent
# sees its inbox and the reads it asked for, then acts: messages, a pinned
# state, reads for next round. A fact counts as delivered to an agent when it
# reaches that agent's context (message or a read of a pinned state that
# carries the fact id) by the deadline. Usage: sim.py <tag> <model> <reps> <policy,...>
import json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
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
ROUNDS = 5

AGENTS = {
    "L": "the Cold Email lead (@cold-email standing session). You spawned W1 to W5 and answer for Deliverability. You report to @growth.",
    "W1": "worker W1 under lead L: measure bounce rates by sending domain.",
    "W2": "worker W2 under lead L: rewrite the send scheduler in src/sched/queue.ts.",
    "W3": "worker W3 under lead L: add per-domain caps, which also means editing src/sched/queue.ts.",
    "W4": "worker W4 under lead L: write new email copy.",
    "W5": "worker W5 under lead L: warm 10 new sending domains, currently sending 600 a day per domain.",
}
# id, holder, discovered round, needed_by, deadline round, text
FACTS = [
    ("F1", "W1", 1, ["W5"], 3, "The inbox provider hard-throttles new domains above 400 a day; anything above that bounces."),
    ("F2", "W1", 2, ["W3"], 4, "Bounces cluster on domains with a missing DMARC record; caps should be per DMARC status, not flat."),
    ("F3", "W4", 1, [], 0, "The new copy uses a friendlier greeting; tests look fine."),
    ("F4", "W2", 2, ["W3"], 3, "W2 will rewrite the whole of src/sched/queue.ts in round 3, replacing the cap hook W3 planned to use."),
    ("F5", "W5", 3, ["W1"], 5, "Three of the warmed domains are on a shared IP whose bounces skew W1's per-domain numbers."),
    ("F6", "W3", 1, [], 0, "W3 found an unrelated typo in a README."),
]


if os.environ.get("WORLD") == "big":
    AGENTS = {
        "L": "the Deliverability lead (@cold-email standing session). You spawned W1 to W10 and answer for Deliverability. You report to @growth.",
        "W1": "worker W1 under lead L: measure bounce rates by sending domain.",
        "W2": "worker W2 under lead L: rewrite the send scheduler in src/sched/queue.ts.",
        "W3": "worker W3 under lead L: add per-domain caps, which also means editing src/sched/queue.ts.",
        "W4": "worker W4 under lead L: write new email copy.",
        "W5": "worker W5 under lead L: warm 10 new sending domains, currently sending 600 a day per domain.",
        "W6": "worker W6 under lead L: build the deliverability dashboard.",
        "W7": "worker W7 under lead L: migrate DNS records (SPF, DKIM, DMARC) for all sending domains.",
        "W8": "worker W8 under lead L: tune reply detection so bounces are not counted as replies.",
        "W9": "worker W9 under lead L: write the weekly deliverability report for Ashot.",
        "W10": "worker W10 under lead L: rotate sender personas across domains.",
    }
    FACTS = [
        ("F1", "W1", 1, ["W5"], 3, "The inbox provider hard-throttles new domains above 400 a day; anything above that bounces."),
        ("F2", "W1", 2, ["W3", "W10"], 4, "Bounces cluster on domains with a missing DMARC record; caps and persona rotation should skip those domains."),
        ("F3", "W4", 1, [], 0, "The new copy uses a friendlier greeting; tests look fine."),
        ("F4", "W2", 2, ["W3"], 3, "W2 will rewrite the whole of src/sched/queue.ts in round 3, replacing the cap hook W3 planned to use."),
        ("F5", "W5", 3, ["W1", "W6"], 5, "Three of the warmed domains are on a shared IP whose bounces skew per-domain numbers."),
        ("F6", "W3", 1, [], 0, "W3 found an unrelated typo in a README."),
        ("F7", "W7", 1, ["W1", "W5"], 3, "DMARC records for 4 domains are wrong until round 3; bounces from them until then are DNS, not reputation."),
        ("F8", "W8", 2, ["W6", "W9"], 4, "Reply detection counted 12% of bounces as replies; every reply-rate number before today is inflated."),
        ("F9", "W6", 2, [], 0, "The dashboard now has a dark mode."),
        ("F10", "W10", 3, ["W9"], 5, "Persona rotation is paused on 2 domains for a week, so their volume drops by half."),
    ]

POLICY_WORDS = {os.path.basename(f)[:-3]: open(f).read().strip() for f in __import__("glob").glob(f"{HERE}/variants/*.md")}

FORMAT = """Act for this round. Answer with JSON only:
{"messages": [{"to": "<agent id>", "text": "..."}], "pinned_state": "one line others can read, or empty", "read": ["agent ids whose pinned state you want to read next round"], "why": "<=25 words"}
When you pass on a fact, include its id in brackets, like [F9]. Messages arrive at the start of next round and cost the recipient a turn. Pinned states cost nobody anything; anyone may read them."""

def system(policy, me):
    guidance = POLICY_WORDS.get(policy, "")
    team = "\n".join(f"  {k}: {v}" for k, v in AGENTS.items())
    return ("You are an AI agent session in codecast. The instructions below are part of your standing context.\n\n" + MESSAGING +
            f"\n\n<org-context>\nThe team:\n{team}\n\nYou are {me}: {AGENTS[me]}\n" + (f"\n{guidance}\n" if guidance else "") + "</org-context>")

def call(d, sysmsg, prompt, model):
    os.makedirs(d, exist_ok=True)
    if not os.path.exists(f"{d}/reply.json"):
        open(f"{d}/system.md", "w").write(sysmsg); open(f"{d}/prompt.md", "w").write(prompt)
        subprocess.run(["rm", "-rf", f"{d}/h"])
        subprocess.run(["bun", HARNESS, "--run", f"{d}/h", "--prompt", f"{d}/prompt.md", "--system", f"{d}/system.md", "--model", model, "--call",
                        "--max-output-tokens", "4000", "--account", os.environ.get("ACCOUNT", "claude7")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900)
        reply = open(f"{d}/h/reply.txt").read() if os.path.exists(f"{d}/h/reply.txt") else ""
        try: out, _ = json.JSONDecoder().raw_decode(reply[reply.index("{"):])
        except Exception: out = {"messages": [], "pinned_state": "", "read": [], "error": reply[:200]}
        json.dump(out, open(f"{d}/reply.json", "w"))
    return json.load(open(f"{d}/reply.json"))

def world(tag, policy, rep, model):
    base = f"{HOME_DIR}/sim/{tag}/{policy}/{rep}"
    inbox = {a: [] for a in AGENTS}; pinned = {a: "" for a in AGENTS}; wants = {a: [] for a in AGENTS}
    seen = {a: "" for a in AGENTS}  # everything that reached an agent's context, per round
    log = []
    known_at = {}  # (fact, agent) -> round it reached them
    for rnd in range(1, ROUNDS + 1):
        prompts = {}
        for a in AGENTS:
            own = [f"[{f}] {t}" for f, h, r0, _, _, t in FACTS if h == a and r0 <= rnd]
            reads = [f"{b}'s pinned state: {pinned[b] or '(empty)'}" for b in wants[a] if b in AGENTS]
            if a == "L" and os.environ.get("LEAD_FEED") and rnd > 1:
                reads = ["Your area's feed (every worker's pinned state, read by your routine):"] + [f"{b}: {pinned[b] or '(empty)'}" for b in AGENTS if b != "L"]
            ctx = (f"Round {rnd} of {ROUNDS}.\n\nWhat you know first-hand:\n" + ("\n".join(own) or "(nothing new)") +
                   "\n\nMessages that arrived for you:\n" + ("\n".join(f"from {m['from']}: {m['text']}" for m in inbox[a]) or "(none)") +
                   "\n\nReads you asked for:\n" + ("\n".join(reads) or "(none)") + f"\n\n{FORMAT}")
            prompts[a] = ctx
            seen_now = ctx
            for f, *_ in FACTS:
                if f"[{f}]" in seen_now and (f, a) not in known_at: known_at[(f, a)] = rnd
        with ThreadPoolExecutor(int(os.environ.get("AGENT_PAR", "6"))) as ex:
            outs = dict(zip(AGENTS, ex.map(lambda a: call(f"{base}/r{rnd}/{a}", system(policy, a), prompts[a], model), AGENTS)))
        inbox = {a: [] for a in AGENTS}
        for a, o in outs.items():
            for m in o.get("messages", []) or []:
                t = str(m.get("to", "")).strip()
                if t in AGENTS and t != a: inbox[t].append({"from": a, "text": str(m.get("text", ""))})
            pinned[a] = str(o.get("pinned_state", "") or "")
            wants[a] = [str(x) for x in (o.get("read", []) or [])][:5]
            log.append({"round": rnd, "agent": a, "sent": [m.get("to") for m in o.get("messages", []) or []], "reads": wants[a], "texts": [str(m.get("text", "")) for m in o.get("messages", []) or []]})
    sends = sum(len(x["sent"]) for x in log)
    lead_in = sum(1 for x in log for t in x["sent"] if t == "L")
    need = [(f, a, dl) for f, h, r0, nb, dl, _ in FACTS for a in nb]
    on_time = [(f, a) for f, a, dl in need if known_at.get((f, a), 99) <= dl]
    noise_spread = sum(1 for x in log for t in x["texts"] if any(f"[{f}]" in t for f, h, r0, nb, dl, _ in FACTS if not nb))
    res = {"policy": policy, "rep": rep, "sends": sends, "to_lead": lead_in, "delivered_on_time": len(on_time), "needed": len(need),
           "missed": [f"{f}->{a}" for f, a, dl in need if (f, a) not in on_time], "noise_spread": noise_spread,
           "latency": {f"{f}->{a}": known_at.get((f, a)) for f, a, dl in need}}
    json.dump({"result": res, "log": log}, open(f"{base}/world.json", "w"), indent=1)
    return res

if __name__ == "__main__":
    tag, model, reps, policies = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4].split(",")
    jobs = [(p, r) for r in range(reps) for p in policies]
    with ThreadPoolExecutor(int(os.environ.get("WORLDS", "3"))) as ex:
        res = list(ex.map(lambda j: world(tag, j[0], j[1], model), jobs))
    json.dump(res, open(f"{HOME_DIR}/sim/{tag}/results.json", "w"), indent=1)
    for p in policies:
        R = [r for r in res if r["policy"] == p]
        n = len(R)
        print(f"{p}: sends {sum(r['sends'] for r in R)/n:.1f}  to_lead {sum(r['to_lead'] for r in R)/n:.1f}  on_time {sum(r['delivered_on_time'] for r in R)/n:.2f}/{R[0]['needed']}  noise {sum(r['noise_spread'] for r in R)/n:.1f}  missed {[m for r in R for m in r['missed']]}")
