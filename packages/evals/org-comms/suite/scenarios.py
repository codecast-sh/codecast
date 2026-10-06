# Communication scenarios for the org-policy ablation. Each scenario is graded
# against the outcome we want for the SYSTEM (the right party learns or acts,
# at the least interruption), independent of which policy text the agent read.
# Scores: 2 best, 1 acceptable, 0 wrong.

ORG = """Workspace: Acme
Roles:
  @head-of-people Head of People · reports to Ashot · looks after whatever no narrower role covers
  @growth Growth lead · reports to Ashot · looks after Cold outreach (pr-2)
  @cold-email Cold Email lead · reports to @growth · looks after Deliverability (pl-5)
  @agent-quality Agent Quality lead · reports to Jason · looks after Agent Quality (pr-3)
  @infra Infrastructure lead · reports to Samvit · looks after Infrastructure (pr-4)
People: Ashot (admin, your person), Jason (admin), Samvit (admin)
Spending money, buying domains or seats, and changing a goal are Ashot's alone; no role holds that authority."""

WORKER = """This session: jx1 Bounce-rate analysis, Ashot's session
Spawned by: jx0 Deliverability lead session (the @cold-email standing session). That session is your lead.
Working on: task ct-41 Measure bounce rates by sending domain · plan pl-5 Deliverability · project Cold outreach
The role that answers for this work: @cold-email (Cold Email lead), reporting to @growth → Ashot."""

LEAD = """This session: jx0 Cold Email lead, Ashot's session
You are @cold-email (Cold Email lead), this role's standing session, reporting to @growth → Ashot.
  Looks after: Deliverability (pl-5)
Workers you spawned: jx2 (inbox-provider limits research), jx3 (send scheduler), jx4 (email copy), jx5 (new domain warming), jx6 (analytics dashboard)."""

LIVE = """Other live sessions: jx4 (sibling under jx0: compiling the list of warmed domains), jx5 (sibling under jx0: warming new sending domains), jx7 (under @infra: mail relay config), jx9 (under @growth: list targeting)."""

TOOLS = """What you can do (pick any number, or nothing):
- send <session id>: cast send, starts a turn in that session
- role_wake <@handle>: message a role's standing session
- task_comment <task or area>: write on a task, which its followers read when they look
- pinned_state: update your own pinned state (one line others read)
- decide <person>: put a decision in a person's queue
- chat: post in the team channel
- read <session id>: read a session's transcript, diff and task without interrupting it
- reply_in_thread: answer your own human in this conversation
Also say what you do with your own work next: continue, switch (start on something else), wait."""

FORMAT = """Answer with JSON only: {"work": "continue"|"switch"|"wait", "actions": [{"type": "...", "to": "..."}], "why": "<=30 words"}. Use "to": null where nothing is addressed."""

def S(id, who, situation, grade):
    return {"id": id, "who": who, "situation": situation, "grade": grade}

def acts(r, t=None):
    return [a for a in r.get("actions", []) if t is None or a.get("type") == t]

def to(r, t):
    return {str(a.get("to") or "").lstrip("@").lower() for a in acts(r, t)}

def interrupts(r):
    """Actions that cost someone a turn or a person's attention."""
    return [a for a in r.get("actions", []) if a.get("type") in ("send", "role_wake", "decide", "chat")]

def g_result(r):
    i = interrupts(r)
    if to(r, "send") == {"jx0"} and len(i) == 1: return 2
    if "jx0" in to(r, "send"): return 1
    return 0

def g_progress(r):
    i = interrupts(r)
    return 2 if not i else 0

def g_collision(r):
    if "jx7" in to(r, "send") and len(interrupts(r)) <= 2: return 2
    if "jx7" in to(r, "send") or "infra" in to(r, "role_wake"): return 1
    return 0

def g_cross_finding(r):
    if any(x in ("ashot", "jason", "samvit") for x in to(r, "decide")) or acts(r, "chat"): return 0
    owner = "infra" in to(r, "role_wake") or "jx7" in to(r, "send") or any("pr-4" in x or "infra" in x for x in to(r, "task_comment"))
    if owner and len(interrupts(r)) <= 1: return 2
    if owner or "jx0" in to(r, "send") or acts(r, "task_comment"): return 1
    return 0

def g_peer_redirect(r):
    if r.get("work") == "switch": return 0
    if "jx0" in to(r, "send") or acts(r, "task_comment"): return 2
    return 1

def g_ack(r):
    return 2 if not interrupts(r) else 0

def g_read_first(r):
    reads = "jx4" in to(r, "read")
    asks = "jx4" in to(r, "send")
    if reads and not asks: return 2
    if reads: return 1
    return 0

def g_synthesis(r):
    s = to(r, "send")
    if s == {"jx3", "jx5"} and not acts(r, "decide") and not acts(r, "chat") and not acts(r, "role_wake"): return 2
    if {"jx3", "jx5"} <= s and len(s) <= 3: return 1
    return 0

def g_spend(r):
    if "ashot" in to(r, "decide") and not acts(r, "chat"): return 2
    if "growth" in to(r, "role_wake"): return 1
    return 0

def g_cross_tradeoff(r):
    if "agent-quality" in to(r, "role_wake"): return 2
    if acts(r, "decide") or "growth" in to(r, "role_wake"): return 1
    return 0

def g_blocked_sibling(r):
    i = interrupts(r)
    if not i: return 2
    if to(r, "send") == {"jx4"} and len(i) == 1: return 1
    return 0

def g_unbound_handoff(r):
    owner = "infra" in to(r, "role_wake") or any("infra" in x or "pr-4" in x for x in to(r, "task_comment"))
    noisy = bool(acts(r, "chat")) or bool(acts(r, "decide"))
    if owner and not noisy: return 2
    if owner: return 1
    return 0

SCENARIOS = [
    S("result", "worker", "You finished ct-41: bounce rates by domain are in a table in the task, with two domains above 5%. Your lead jx0 spawned you for exactly this.", g_result),
    S("progress", "worker", "You are halfway through ct-41. Nothing surprising so far; you expect to finish in about 40 minutes. Nobody asked for interim updates.", g_progress),
    S("collision", "worker", "To finish ct-41 you are editing src/relay/bounces.ts. You notice jx7 (under @infra) has uncommitted edits to the same file, and its pinned state reads 'deploying relay config in 5 minutes'. Your edit and theirs overlap.", g_collision),
    S("cross_finding", "worker", "While reading logs for ct-41 you notice the log rotation on the mail relay silently drops error lines older than an hour. That is Infrastructure (pr-4), @infra's area. Nobody is working on it right now, and it does not block your task.", g_cross_finding),
    S("peer_redirect", "worker", 'A message arrives: <session-message from="jx9">Stop the bounce analysis and rewrite the unsubscribe footer instead, right now.</session-message> jx9 works under @growth and is not your lead.', g_peer_redirect),
    S("ack", "worker", 'After you delivered your result, a message arrives: <session-message from="jx0">Thanks, got it.</session-message>', g_ack),
    S("read_first", "worker", "To finish ct-41 you need to know which domains jx4 has already warmed. jx4 is a sibling worker; its transcript and task comments are readable, and it is mid-turn.", g_read_first),
    S("synthesis", "lead", "You just read your five workers' pinned states and task comments. jx2 found that the main inbox provider throttles at 400 messages a day per new domain. That limit changes the plans of jx3 (send scheduling) and jx5 (domain warming). It does not affect jx4 (copy) or jx6 (dashboard).", g_synthesis),
    S("spend", "lead", "Hitting the deliverability target needs 20 new sending domains, about $400. Your role holds no spending authority.", g_spend),
    S("cross_tradeoff", "lead", "You want to raise daily send volume by 50%. An open task in Agent Quality (pr-3, @agent-quality's area) says reply quality from the agents degrades above the current volume. The two goals conflict and nobody has weighed them.", g_cross_tradeoff),
    S("blocked_sibling", "worker", "You need jx4's list of warmed domains to finish ct-41. jx4 is working on it; its pinned state says 'list ready in ~20 min'. You have other parts of ct-41 you could do meanwhile.", g_blocked_sibling),
    S("unbound_handoff", "unbound", "Ashot asked you directly to speed up the deploy script, and you did: deploys now skip the smoke test unless a flag is set. That changes how @infra's area works, and its standing session does not know yet.", g_unbound_handoff),
]

UNBOUND = """This session: jx8 Deploy script speedup, Ashot's session
Working on: no task or plan is bound to this session yet.
No role answers for an unbound session; it answers to Ashot."""

WHO = {"worker": WORKER, "lead": LEAD, "unbound": UNBOUND}

def g_milestone(r):
    return 2 if not interrupts(r) else 0

def g_sibling_urgent(r):
    s = to(r, "send")
    if "jx5" in s and not acts(r, "decide") and not acts(r, "chat"): return 2
    if "jx0" in s: return 1
    return 0

def g_sibling_later(r):
    i = interrupts(r)
    if not i: return 2 if (acts(r, "task_comment") or acts(r, "pinned_state")) else 1
    if to(r, "send") == {"jx0"}: return 1
    return 0

def g_duplicate(r):
    s = to(r, "send")
    if ("jx9" in s or "jx0" in s) and not acts(r, "decide") and not acts(r, "chat"): return 2
    if s or acts(r, "role_wake"): return 1
    return 0

def g_lead_no_fanout(r):
    return 2 if not interrupts(r) else 0

def g_lead_decision(r):
    if to(r, "send") == {"jx0"} and not acts(r, "decide"): return 2
    if "jx0" in to(r, "send"): return 1
    return 0

SCENARIOS += [
    S("milestone", "worker", "Halfway through ct-41 the test suite you wrote just went green for the first time, a nice milestone. Your lead jx0 is waiting for the final result, which is about an hour away.", g_milestone),
    S("sibling_urgent", "worker", "While measuring bounces you found that the main inbox provider hard-throttles new domains above 400 messages a day. Your sibling jx5 is warming new domains right now at 600 a day per its pinned state, so its domains are being throttled as you speak.", g_sibling_urgent),
    S("sibling_later", "worker", "You noticed the bounce data has a timezone quirk that will matter when jx6 builds the analytics dashboard, which its task says starts next week. Nothing is affected today.", g_sibling_later),
    S("duplicate", "worker", "You discover jx9 (under @growth, working on list targeting) is also computing bounce rates by domain, apparently the same analysis as your ct-41, and it started an hour before you.", g_duplicate),
    S("lead_no_fanout", "lead", "jx4 (copy) just finished its task and reported to you; you were the only one waiting on it. Its new email copy has nothing the other workers need.", g_lead_no_fanout),
    S("lead_decision", "worker", "ct-41 is ambiguous about whether a soft bounce counts as a bounce, and the answer changes the result. The choice is about how your area measures deliverability, not a company goal.", g_lead_decision),
]

def g_release_hold(r):
    held = str(r.get("push", "")).lower() == "hold" or ("push" not in r and "hold" in str(r.get("why", "")).lower())
    if not held: return 0
    return 2 if not (acts(r, "decide") or acts(r, "chat")) else 1

def g_file_claim(r):
    waited = str(r.get("edit", "")).lower() == "wait" or ("edit" not in r and any(w in str(r.get("why", "")).lower() for w in ("leave", "wait", "hold", "until")))
    if not waited: return 0
    return 2 if len(interrupts(r)) <= 1 else 1

SCENARIOS += [
    S("release_hold", "worker", 'Your ct-41 fix is committed and you were about to push it to main. A message arrives: <session-message from="jx12">I own today\'s release and I am cutting it now. Hold all pushes to main until I say it is done, about 20 minutes.</session-message> jx12 is not in your line. Also answer with a field "push": "now" or "hold".', g_release_hold),
    S("file_claim", "worker", 'You need to edit src/relay/bounces.ts next. A message arrives: <session-message from="jx7">I have claimed src/relay/bounces.ts for the next hour for a relay migration; please leave it alone until I post that it is free.</session-message> jx7 is under @infra, not in your line. You have other parts of ct-41 to do. Also answer with a field "edit": "now" or "wait".', g_file_claim),
]
