import { test } from "bun:test";
import { installDom, installMissingBackend, describeFailures, seedViewer } from "../../test-helpers/missingBackend";
const which = process.env.SCRATCH!;
const table: Record<string, [string, string, () => Promise<any>]> = {
  org: ["/org", "org", () => import("../../app/org/page")],
  tasks: ["/tasks", "tasks", () => import("../../app/tasks/page")],
  chat: ["/chat", "chat", () => import("../../app/chat/page")],
  calls: ["/calls", "calls", () => import("../../app/calls/page")],
  conv: ["/conversation/" + "convcached".padEnd(32, "0"), "conversation/:id", () => import("../../app/conversation/[id]/page")],
};
const [path, route, load] = table[which];
const { mountPage } = installDom("https://app.test" + path);
const backend = await installMissingBackend();
await seedViewer();
if (which === "conv") {
  const { useInboxStore } = await import("../../store/inboxStore");
  const id = "convcached".padEnd(32, "0");
  const now = Date.now();
  useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: "s-cached", user_id: (useInboxStore.getState().currentUser as any)._id, owned_by_me: true, title: "Cached refactor session", status: "active", started_at: now - 3600000, updated_at: now - 60000, message_count: 2, is_idle: true, agent_type: "claude_code", project_path: "/src/app" }] as any);
  useInboxStore.setState((s: any) => ({ conversations: { ...s.conversations, [id]: { _id: id, title: "Cached refactor session", user_id: s.currentUser._id, is_own: true, messages: [{ _id: "m1".padEnd(32, "0"), role: "user", content: "Rename the store slice", timestamp: now - 120000 }, { _id: "m2".padEnd(32, "0"), role: "assistant", content: "Renamed it in four files.", timestamp: now - 60000 }], message_count: 2, updated_at: now - 60000 } } }));
}
test(which, async () => {
  const { default: Page } = await load();
  const { default: Inbox } = await import("../../app/inbox/page");
  const s = await mountPage(path, { [route]: <Page />, inbox: <Inbox /> });
  console.log("FAIL\n" + describeFailures(s));
  console.log("REFUSED " + [...backend.refused].join(" "));
  console.log("TEXT " + s.text().slice(0, 1500));
  await s.unmount();
}, 120_000);
