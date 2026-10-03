// The smoke suite's world on the local deployment (stack.mjs), written
// through the backend's own functions under an admin client: Convex Auth's
// `auth:store` creates the two test identities the way a password sign up
// does, and every other row comes from the mutation a person's click would
// call, acting as that person. Nothing here runs against prod: both entry
// points refuse any deployment that is not the local one.
//
// The world (people, team, features) is idempotent and stays between runs.
// The fixtures a leg reads (one session with two messages, one chat channel)
// are made fresh each run and the previous run's are removed, and each
// person's open tabs are closed, so every run's screens start from the same
// state and the baselines compare like with like.
import { adminClient } from "./stack.mjs";

export const SMOKE_PEOPLE = {
  riley: { email: "riley@smoke.invalid", name: "Riley Smoke", port: 9621 },
  jordan: { email: "jordan@smoke.invalid", name: "Jordan Smoke", port: 9622 },
};
export const SMOKE_TEAM = "Smoke Team";
const SMOKE_PROJECT_HASH = "codecast-smoke";
export const SMOKE_SESSION = {
  title: "Fix the flaky login redirect test",
  user: "The login redirect test fails about one run in ten. Find out why and fix it.",
  assistant: "The redirect waits on a fixed 200 ms timer, so a slow first paint loses the race. I replaced the timer with a wait on the router's ready event; the test passed 50 runs in a row.",
};
export const SMOKE_CHANNEL = { name: "smoke-check", topic: "Where the smoke suite talks" };

function requireLocal(dep) {
  if (dep.kind !== "local") throw new Error(`the smoke world is seeded only on the local deployment, not ${dep.kind}`);
}

/** People, team, membership, features. Returns their ids. */
export async function seedWorld(dep) {
  requireLocal(dep);
  const admin = adminClient(dep);
  const ids = {};
  for (const [who, p] of Object.entries(SMOKE_PEOPLE)) {
    // No secret: an account that exists is returned as it is.
    const r = await admin.mutation("auth:store", {
      args: { type: "createAccountFromCredentials", provider: "password", account: { id: p.email }, profile: { email: p.email, name: p.name }, shouldLinkViaEmail: false, shouldLinkViaPhone: false },
    });
    ids[who] = String(r.user._id);
  }
  // client_key makes a repeated create return the team it already made.
  const teamId = await adminClient(dep, ids.riley).mutation("teams:createTeam", { name: SMOKE_TEAM, client_key: "codecast-smoke-team" });
  await admin.mutation("teams:addMemberByOperator", { user_id: ids.jordan, team_id: teamId });
  for (const feature of ["chat", "org"]) await admin.mutation("teamFeatures:setTeamFeatureInternal", { team_id: teamId, feature, enabled: true });
  for (const id of Object.values(ids)) {
    const me = adminClient(dep, id);
    // Tips off, as the settings page sets it (the client's persistClientTips
    // action), so no first visit tour covers a page in a shot.
    await me.mutation("dispatch:dispatch", { action: "persistClientTips", args: [{ level: "none" }] });
    // The team as the workspace, as the workspace switcher sets it
    // (useSwitchWorkspace): the stamped clientState.ui mirror the web reads,
    // then the canonical users.active_team_id. In the same write, the org
    // introduction as already seen (markOrgIntroSeen), so the org page opens
    // on the chart and no page carries the card that sells it.
    const prefs = { active_team_id: teamId, org_intro_seen: true, org_upsell_seen: true };
    const ui = { ...prefs, ...Object.fromEntries(Object.keys(prefs).map((k) => [`${k}:ts`, Date.now()])) };
    await me.mutation("dispatch:dispatch", { action: "updateClientUI", args: [prefs], result: ui });
    await me.mutation("teams:setActiveTeam", { team_id: teamId });
  }
  return { ...ids, teamId: String(teamId) };
}

/** This run's session and channel, the previous run's removed. */
export async function seedRun(dep, world) {
  requireLocal(dep);
  const riley = adminClient(dep, world.riley);
  // The open tabs live on the server (client_state), and a fresh browser
  // adopts them: the previous run's last page and its session's tab would
  // come back, the tab strip in every shot would depend on whether that
  // run's last tab write landed, and a tab on the deleted session would
  // bring its title back as a row. Close them all, as closing every tab
  // does (the same patch rail), before the session goes.
  for (const id of [world.riley, world.jordan]) {
    await adminClient(dep, id).mutation("dispatch:dispatch", {
      action: "closeTab", args: [], patches: { client_state: { [id]: { tabs: null, activeTabId: null, current_conversation_id: null } } },
    });
  }
  // deleteByProjectHash removes one session 50 messages a call.
  for (let convId, i = 0; i < 50; i++) {
    const r = await riley.mutation("conversations:deleteByProjectHash", { project_hash: SMOKE_PROJECT_HASH, ...(convId ? { conv_id: convId } : {}) });
    convId = r.hasMore ? r.conv_id : undefined;
    if (!r.hasMore && !r.deleted) break;
  }
  const conversationId = String(await riley.mutation("conversations:createConversation", {
    user_id: world.riley, team_id: world.teamId, agent_type: "claude_code", session_id: crypto.randomUUID(),
    project_hash: SMOKE_PROJECT_HASH, project_path: "/tmp/codecast-smoke", title: SMOKE_SESSION.title, started_at: Date.now(),
  }));
  for (const role of ["user", "assistant"]) {
    await riley.mutation("messages:addMessage", { conversation_id: conversationId, role, content: SMOKE_SESSION[role], message_uuid: crypto.randomUUID() });
  }
  // The previous run's channel is archived and renamed out of the way, so
  // this run's channel takes the same name and starts empty.
  const channels = await riley.query("chat:listChannels", { team_id: world.teamId });
  for (const c of (channels?.channels ?? channels ?? []).filter((c) => c.name === SMOKE_CHANNEL.name)) {
    await riley.mutation("chat:updateChannel", { channel_id: c._id, name: `${SMOKE_CHANNEL.name}-${String(c._id).slice(-6)}` });
    await riley.mutation("chat:archiveChannel", { channel_id: c._id, archived: true });
  }
  const created = await riley.mutation("chat:createChannel", { team_id: world.teamId, name: SMOKE_CHANNEL.name, topic: SMOKE_CHANNEL.topic });
  const channelId = String(created?.channel_id ?? created?._id ?? created);
  return { conversationId, channelId };
}
