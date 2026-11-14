// Acme's integrations as Settings > Integrations shows them: GitHub connected
// for the team by Alex, with acme/acme-api importing its issues into the
// Webhooks project (delegate label "agent", a session spawned on delegation);
// Slack and Linear not connected yet. Mobile's Metro reaches this file, so
// imports stay relative.

import type { AcmePart } from "./parts";
import { CODE_REPO } from "./code";
import { DAY, MIN, TEAM_ID, WORKSPACE, cid } from "./world";

const connections = (now: number) => ({
  team: { id: TEAM_ID, name: "Acme" },
  apps: [
    { id: "github", status: "connected", scope: "team", by: "Alex Rivera", by_me: true, at: now - 40 * DAY, detail: "acme (3 repositories)", health: { last_webhook_at: now - 2 * MIN } },
    { id: "slack", status: "not_connected", scope: "team" },
    { id: "linear", status: "not_connected", scope: "team" },
  ],
});

const sources = (now: number) => [
  {
    _id: cid("issuesrcacmeapi"),
    provider: "github",
    kind: "repo",
    name: CODE_REPO,
    status: "active",
    project_id: cid("projwebhooks"),
    project_name: "Webhooks",
    project_title: "Webhooks",
    delegate_label: "agent",
    auto_spawn: true,
    push_new_tasks: false,
    last_synced_at: now - 4 * MIN,
    last_webhook_at: now - 2 * MIN,
    workspace: WORKSPACE,
    team_id: TEAM_ID,
    created_at: now - 20 * DAY,
  },
];

export const INTEGRATIONS_PART: AcmePart = {
  name: "integrations",
  answers: {
    "appConnections:listConnections": () => connections(Date.now()),
    "issueSync:listSources": () => sources(Date.now()),
  },
};
