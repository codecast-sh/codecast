#!/usr/bin/env python3
"""How agent sessions talk to each other, measured from prod.

One run reads the queued messages between one person's sessions over a window,
places each sender against its recipient (parent, worker, sibling, unrelated
peer, huddle feed), reads a random sample inside the recipient's transcript and
has a model label what each message did, then writes one report beside the
earlier ones so a change shows as a moved number.

Everything real (exports, transcripts read, labels, reports) lives in
$CODECAST_EVALS_HOME/org-comms (default ~/.local/share/codecast/evals), never
in git. The study this continues: docs/architecture/agent-comms.md.

    python3 packages/evals/org-comms/monitor.py [--days 7] [--sample 120]
        [--user <users id>] [--account <profile>] [--model <id>] [--skip-export]
"""
import argparse, collections, datetime, glob, json, os, random, re, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
HARNESS = os.path.join(REPO, "packages/cli/scripts/prompt-dry-run.ts")
ASHOT = "kd700q4pr2m98a3nghfesw4vxx7wkn6z"


def convex_data(table, limit, out):
    """`npx convex data` against prod, with the repo-root .env.local moved aside
    the way packages/convex/run.sh does (its anonymous pointer hijacks the CLI)."""
    env_local, hold = os.path.join(REPO, ".env.local"), os.path.join(REPO, ".env.local.orgcomms-hold")
    moved = os.path.exists(env_local)
    if moved: os.rename(env_local, hold)
    try:
        env = {k: v for k, v in os.environ.items() if k != "CONVEX_DEPLOYMENT"}
        with open(out, "w") as f:
            subprocess.run(["npx", "convex", "data", table, "--limit", str(limit), "--format", "jsonl"],
                           cwd=os.path.join(REPO, "packages/convex"), env=env, stdout=f, stderr=subprocess.DEVNULL, check=True)
    finally:
        if moved and os.path.exists(hold): os.rename(hold, env_local)


def load_jsonl(p):
    out = []
    for line in open(p):
        try: out.append(json.loads(line))
        except Exception: pass
    return out


def relation(msg, convs, short):
    sender = msg["sender"]
    # Codecast's own notices (a reporting line moved, a send still queued) carry
    # no agent sender either: they are neither huddle talk nor agent traffic.
    if sender == "codecast": return "system"
    if sender == "unknown":
        head = re.sub(r"^<session-message[^>]*>\s*", "", msg["content"])[:120]
        return "huddle-feed" if re.search(r"huddle|talking in this session|voice in the call", head, re.I) else "system"
    rc = convs.get(msg["conversation_id"])
    # A short id is a 7 character prefix and thousands collide across users, so
    # one sender id can name several sessions: take the reading closest to the
    # recipient's line, since a stranger sharing a parent's prefix is not the sender.
    found = [place(rc, sc, convs) for sc in short.get(sender, [])] if rc else []
    return min(found, key=LINE_ORDER.index) if found else "unresolved"


LINE_ORDER = ["parent->worker", "worker->parent", "sibling", "ancestor", "descendant", "role", "peer"]


def place(rc, sc, convs):
    if rc.get("parent_conversation_id") == sc["_id"]: return "parent->worker"
    if sc.get("parent_conversation_id") == rc["_id"]: return "worker->parent"
    if sc.get("parent_conversation_id") and sc.get("parent_conversation_id") == rc.get("parent_conversation_id"): return "sibling"
    for a, b in ((rc, sc["_id"]), (sc, rc["_id"])):
        p, d = a.get("parent_conversation_id"), 0
        while p and d < 6:
            if p == b: return "ancestor" if a is rc else "descendant"
            p, d = convs.get(p, {}).get("parent_conversation_id"), d + 1
    if rc.get("standing_role_id") or sc.get("standing_role_id"): return "role"
    return "peer"


def fill_long_lived(convs, short, msgs, user):
    """The export holds the newest sessions, so a long-lived one (a role's
    standing session above all) falls out of it while still sending every
    day. Look those up by id; such a session runs at the top of its line, so
    only its role is needed to place it. A role's anchor session belongs to
    the role's bot user, so the person's own session list never returns it:
    the org listing of each of their teams names those."""
    def add(row):
        convs.setdefault(row["_id"], row)
        if convs[row["_id"]] not in short[row["short_id"]]: short[row["short_id"]].append(convs[row["_id"]])
    teams = re.findall(r"\bk97[a-z0-9]{29}\b", subprocess.run(["cast", "teams"], capture_output=True, text=True).stdout)
    for team in teams:
        out = subprocess.run(["cast", "org", "ls", "--team", team, "--json"], capture_output=True, text=True, timeout=300).stdout
        try: anchors = json.loads(out).get("anchors", [])
        except Exception: continue
        for x in anchors:
            add({"_id": x["conversation_id"], "short_id": x["short_id"], "title": x.get("name"), "parent_conversation_id": None,
                 "standing_role_id": x.get("org_role_id"), "session_id": None, "user_id": x.get("bot_user_id")})
    want = {m["conversation_id"] for m in msgs if m["conversation_id"] not in convs}
    want |= {m["sender"] for m in msgs if m["sender"] not in ("unknown", "codecast") and not short.get(m["sender"])}
    want = sorted(want)
    for i in range(0, len(want), 25):
        out = subprocess.run(["cast", "sessions", *want[i:i + 25], "--json"], capture_output=True, text=True, timeout=300).stdout
        try: rows = json.loads(out).get("sessions", [])
        except Exception: continue
        for r in rows:
            add({"_id": r["id"], "short_id": r["id"][:7], "title": r.get("title"), "parent_conversation_id": None,
                 "standing_role_id": (r.get("role") or {}).get("handle"), "session_id": r.get("session_id"),
                 "user_id": user if r.get("owned_by_me") else None})
    return len(want)


def saw_guidance(session_id, transcripts):
    """Whether a session's start actually showed it the org guidance: Claude
    Code cuts start-hook output over about 9.8KB to a preview, and a session
    whose transcript is not on this machine cannot be told."""
    f = transcripts.get(session_id or "")
    if not f: return "unknown"
    head = ""
    with open(f, errors="ignore") as fh:
        for i, line in enumerate(fh):
            if i > 40: break
            head += line
    return "saw" if "org-context" in head and "Output too large" not in head else "did not see"


def call_model(run_dir, prompt, system, model, account):
    os.makedirs(run_dir, exist_ok=True)
    reply_path = os.path.join(run_dir, "h", "reply.txt")
    prompt_path = os.path.join(run_dir, "prompt.md")
    same = os.path.exists(prompt_path) and open(prompt_path).read() == prompt
    if not (same and os.path.exists(reply_path) and "Failed to authenticate" not in open(reply_path).read() and "limit" not in open(reply_path).read()[:200]):
        subprocess.run(["rm", "-rf", os.path.join(run_dir, "h")])
        open(prompt_path, "w").write(prompt)
        args = ["bun", HARNESS, "--run", os.path.join(run_dir, "h"), "--prompt", prompt_path,
                "--system", system, "--model", model, "--call", "--max-output-tokens", "16000"]
        if account: args += ["--account", account]
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
    reply = open(reply_path).read() if os.path.exists(reply_path) else ""
    try: return json.JSONDecoder().raw_decode(reply[reply.index("["):])[0]
    except Exception: return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--sample", type=int, default=120)
    ap.add_argument("--user", default=ASHOT, help="whose sessions to read (only their own content is opened)")
    ap.add_argument("--account", default=os.environ.get("CODECAST_EVALS_ACCOUNT"))
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--skip-export", action="store_true")
    a = ap.parse_args()

    today = datetime.date.today().isoformat()
    run = os.path.join(HOME, "runs", today)
    os.makedirs(run, exist_ok=True)
    exp = os.path.join(HOME, "export")
    os.makedirs(exp, exist_ok=True)
    if not a.skip_export:
        print("exporting pending_messages and conversations from prod…", flush=True)
        convex_data("pending_messages", 60000, os.path.join(exp, "pending.jsonl"))
        # 100,000 is the most one `convex data` call returns (about four
        # weeks of every user's sessions in late October); fill_long_lived
        # places the older senders.
        convex_data("conversations", 100000, os.path.join(exp, "convs.jsonl"))

    keep = ["_id", "_creationTime", "short_id", "title", "user_id", "parent_conversation_id", "standing_role_id", "org_role_id", "session_id"]
    convs = {r["_id"]: {k: r.get(k) for k in keep} for r in load_jsonl(os.path.join(exp, "convs.jsonl"))}
    short = collections.defaultdict(list)
    for c in convs.values():
        if c.get("short_id"): short[c["short_id"]].append(c)
    since = (datetime.datetime.now() - datetime.timedelta(days=a.days)).timestamp() * 1000
    msgs = []
    for r in load_jsonl(os.path.join(exp, "pending.jsonl")):
        if r["_creationTime"] < since or r.get("from_user_id") != a.user or not r["content"].startswith("<session-message"): continue
        m = re.match(r'<session-message from="([^"]+)"', r["content"])
        r["sender"] = m.group(1) if m else "unknown"
        msgs.append(r)
    looked_up = fill_long_lived(convs, short, msgs, a.user)
    for r in msgs: r["rel"] = relation(r, convs, short)
    notices = sum(1 for m in msgs if m["rel"] == "system")
    msgs = [m for m in msgs if m["rel"] != "system"]
    print(f"{len(msgs)} messages in the last {a.days} days ({notices} system notices left out, {looked_up} sessions outside the export looked up)", flush=True)

    # Shape: counts that need no model.
    rel = collections.Counter(m["rel"] for m in msgs)
    huddle = [m for m in msgs if m["rel"] == "huddle-feed"]
    # Only the context lane is unnamed talk, and its header always says so. The
    # rest (a named line, a voice handoff, a chat line, the attach briefing) is
    # asked-for or one-off, and never gapped.
    unnamed_of = lambda m: "Nobody named you" in m["content"][:1500]
    named = sum(1 for m in huddle if not unnamed_of(m))
    # AC3's direct check: how often an unnamed chunk reached a session less than
    # the context gap after the one before it, inside one call (pairs under an hour).
    arrivals = collections.defaultdict(list)
    for m in huddle:
        if unnamed_of(m): arrivals[m["conversation_id"]].append(m["_creationTime"])
    gaps = [b - t for v in arrivals.values() for t, b in zip(sorted(v), sorted(v)[1:]) if b - t < 3600_000]
    inside_gap = round(100 * sum(1 for g in gaps if g < 170_000) / len(gaps), 1) if gaps else None
    per_recipient = collections.Counter(m["conversation_id"] for m in msgs if m["rel"] != "huddle-feed")
    senders_of = collections.defaultdict(set)
    for m in msgs:
        if m["rel"] != "huddle-feed": senders_of[m["conversation_id"]].add(m["sender"])
    agent_total = sum(per_recipient.values()) or 1
    hubs = [k for k, s in senders_of.items() if len(s) >= 5]
    # A parent hearing from many of its own workers is the line working, not an
    # informal hub: the same reading with reports from a recipient's descendants left out.
    own = ("worker->parent", "descendant")
    per_outside, senders_outside = collections.Counter(), collections.defaultdict(set)
    for m in msgs:
        if m["rel"] not in own and m["rel"] != "huddle-feed":
            per_outside[m["conversation_id"]] += 1
            senders_outside[m["conversation_id"]].add(m["sender"])
    hubs_outside = [k for k, s in senders_outside.items() if len(s) >= 5]
    created = sum(1 for c in convs.values() if c.get("user_id") == a.user and c.get("_creationTime", 0) >= since)
    dup = collections.Counter((m["conversation_id"], m["content"]) for m in msgs)

    # Sample and read.
    # Only the person's own sessions are opened: a message they sent into a
    # teammate's session is counted above and never read.
    pool = [m for m in msgs if m.get("echo_message_id") and m["status"] == "delivered"
            and (convs.get(m["conversation_id"]) or {}).get("user_id") == a.user]
    sample = random.Random(today).sample(pool, min(a.sample, len(pool)))
    ctx_dir = os.path.join(run, "ctx")
    os.makedirs(ctx_dir, exist_ok=True)

    def fetch(m):
        p = os.path.join(ctx_dir, m["_id"] + ".txt")
        if not os.path.exists(p) or os.path.getsize(p) < 50:
            url = f"https://codecast.sh/conversation/{m['conversation_id']}#msg-{m['echo_message_id']}"
            with open(p, "w") as f: subprocess.run(["cast", "read", url, "-c", "4"], stdout=f, stderr=subprocess.STDOUT, timeout=300)
        return p
    print(f"reading {len(sample)} messages in their recipients' transcripts…", flush=True)
    with ThreadPoolExecutor(6) as ex: list(ex.map(fetch, sample))

    def clip(t, n=6000):
        t = re.sub(r"\n{3,}", "\n\n", t)
        return t if len(t) <= n else t[: n // 2] + "\n[...]\n" + t[-n // 2:]
    cases = [(m["_id"], f"## Case {m['_id']}\nRelationship of sender to recipient: {m['rel']}\n\n{clip(open(os.path.join(ctx_dir, m['_id'] + '.txt')).read())}")
             for m in sample if "linked" in open(os.path.join(ctx_dir, m["_id"] + ".txt")).read()]
    batches = [cases[i:i + 10] for i in range(0, len(cases), 10)]
    system = os.path.join(HERE, "classify-system.md")
    print(f"labelling {len(cases)} cases in {len(batches)} calls…", flush=True)
    with ThreadPoolExecutor(4) as ex:
        outs = list(ex.map(lambda i: call_model(os.path.join(run, "label", f"b{i:02d}"), "\n\n".join(c for _, c in batches[i]), system, a.model, a.account), range(len(batches))))
    rel_of = {m["_id"]: m["rel"] for m in sample}
    transcripts = {os.path.basename(f)[:-6]: f for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl"))}
    def sender_saw(m):
        cands = [c for c in short.get(m["sender"], []) if c.get("session_id")]
        return saw_guidance(cands[0]["session_id"], transcripts) if cands else "unknown"
    seen_of = {m["_id"]: sender_saw(m) for m in sample}
    labels = [dict(x, rel=rel_of.get(x.get("id")), guidance=seen_of.get(x.get("id"))) for o in outs if o for x in o]
    json.dump(labels, open(os.path.join(run, "labels.json"), "w"), indent=1)

    ag = [x for x in labels if x["rel"] != "huddle-feed"]
    hd = [x for x in labels if x["rel"] == "huddle-feed"]
    pct = lambda xs, f: round(100 * sum(1 for x in xs if f(x)) / len(xs), 1) if xs else None
    directing = [x for x in ag if x.get("directs")]
    outside = [x for x in directing if x["rel"] not in ("parent->worker", "ancestor")]
    report = {
        "date": today, "days": a.days, "user": a.user,
        "messages": len(msgs), "system_notices": notices, "sessions_created": created,
        "messages_per_new_session": round(len(msgs) / created, 3) if created else None,
        "by_relation": dict(rel.most_common()),
        "huddle": {"chunks": len(huddle), "named": named, "unnamed": len(huddle) - named, "inside_gap_pct": inside_gap, "noise_pct": pct(hd, lambda x: x.get("noise"))},
        "hubs": {"recipients_with_5plus_senders": len(hubs), "their_share_pct": round(100 * sum(per_recipient[k] for k in hubs) / agent_total, 1),
                 "top": [{"title": (convs.get(k) or {}).get("title"), "messages": per_recipient[k], "senders": len(senders_of[k])} for k, _ in per_recipient.most_common(5)],
                 "outside_own_workers": {"recipients_with_5plus_senders": len(hubs_outside), "their_share_pct": round(100 * sum(per_outside[k] for k in hubs_outside) / agent_total, 1),
                                         "top": [{"id": k, "title": (convs.get(k) or {}).get("title"), "role": (convs.get(k) or {}).get("standing_role_id"), "messages": per_outside[k], "senders": len(senders_outside[k])}
                                                 for k, _ in per_outside.most_common(5)]}},
        "exact_duplicates": sum(v - 1 for v in dup.values() if v > 1),
        "labelled": {"agent_to_agent": len(ag), "huddle": len(hd)},
        "agent_to_agent": {
            "noise_pct": pct(ag, lambda x: x.get("noise")),
            "changed_pct": pct(ag, lambda x: x.get("effect") == "changed"),
            "readable_pct": pct(ag, lambda x: x.get("readable")),
            "readable_idle_pct": pct(ag, lambda x: x.get("readable") and not x.get("urgent") and x.get("effect") != "changed"),
            # The same, leaving out a result the recipient asked for: a worker's
            # one finished report is the handoff the messaging guidance asks for.
            "readable_idle_unasked_pct": pct(ag, lambda x: x.get("readable") and not x.get("urgent") and x.get("effect") != "changed" and not (x.get("kind") == "result" and x.get("solicited"))),
            "urgent_pct": pct(ag, lambda x: x.get("urgent")),
            "kinds": dict(collections.Counter(x.get("kind") for x in ag).most_common()),
            "directing": len(directing), "directing_from_outside_line": len(outside),
            "outside_line_kinds": dict(collections.Counter(x.get("kind") for x in outside).most_common()),
            "outside_line_followed_pct": pct(outside, lambda x: x.get("effect") == "changed"),
            # The wording's own effect: the same reading for senders whose start
            # showed them the org guidance and for those it did not.
            "by_guidance": {g: {"n": len(xs), "changed_pct": pct(xs, lambda x: x.get("effect") == "changed"), "noise_pct": pct(xs, lambda x: x.get("noise")),
                                "readable_idle_unasked_pct": pct(xs, lambda x: x.get("readable") and not x.get("urgent") and x.get("effect") != "changed" and not (x.get("kind") == "result" and x.get("solicited"))),
                                "peer_pct": pct(xs, lambda x: x["rel"] == "peer"), "directs_outside_line_pct": pct(xs, lambda x: x.get("directs") and x["rel"] not in ("parent->worker", "ancestor"))}
                            for g, xs in ((g, [x for x in ag if x.get("guidance") == g]) for g in ("saw", "did not see", "unknown"))},
            "worker_to_parent_readable_pct": pct([x for x in ag if x["rel"] == "worker->parent"], lambda x: x.get("readable")),
        },
    }
    json.dump(report, open(os.path.join(run, "report.json"), "w"), indent=1)

    # One line per metric against every earlier report, oldest first.
    reports = []
    for d in sorted(os.listdir(os.path.join(HOME, "runs"))):
        p = os.path.join(HOME, "runs", d, "report.json")
        if os.path.exists(p): reports.append(json.load(open(p)))
    base = os.path.join(HERE, "baseline.json")
    if os.path.exists(base): reports.insert(0, json.load(open(base)))
    rows = [("messages/new session", lambda r: r.get("messages_per_new_session")),
            ("huddle chunks unnamed", lambda r: r["huddle"]["unnamed"] if r.get("days") == 7 else round(r["huddle"]["unnamed"] * 7 / r["days"])),
            ("unnamed chunks inside the 3 min gap %", lambda r: r["huddle"]["inside_gap_pct"]),
            ("huddle noise %", lambda r: r["huddle"]["noise_pct"]),
            ("agent noise %", lambda r: r["agent_to_agent"]["noise_pct"]),
            ("changed recipient %", lambda r: r["agent_to_agent"]["changed_pct"]),
            ("could have been read %", lambda r: r["agent_to_agent"]["readable_pct"]),
            ("read, idle, unchanged %", lambda r: r["agent_to_agent"]["readable_idle_pct"]),
            ("same, asked-for results left out %", lambda r: r["agent_to_agent"]["readable_idle_unasked_pct"]),
            ("peer share %", lambda r: round(100 * r["by_relation"].get("peer", 0) / max(1, r["messages"] - r["huddle"]["chunks"]), 1)),
            ("outside-line direction followed %", lambda r: r["agent_to_agent"]["outside_line_followed_pct"]),
            ("hub share %", lambda r: r["hubs"]["their_share_pct"]),
            ("same, own workers' reports left out %", lambda r: r["hubs"]["outside_own_workers"]["their_share_pct"])]
    lines = [f"# Agent communication, {today} (last {a.days} days)", "", "| metric | " + " | ".join(r["date"] for r in reports) + " |", "|---" * (len(reports) + 1) + "|"]
    for name, f in rows:
        vals = []
        for r in reports:
            try: vals.append(str(f(r)))
            except Exception: vals.append("")
        lines.append(f"| {name} | " + " | ".join(vals) + " |")
    lines += ["", f"Messages {len(msgs)}, by relation: {dict(rel.most_common())}", f"Labelled: {len(ag)} agent-to-agent, {len(hd)} huddle."]
    open(os.path.join(run, "report.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nreport: {os.path.join(run, 'report.md')}")


if __name__ == "__main__":
    sys.exit(main())
