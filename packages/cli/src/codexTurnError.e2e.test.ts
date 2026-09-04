import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { CodexAppServer } from "./codexAppServer";
import { recoverCodexTurn } from "./codexTurnRecovery";
import { classifyApiErrorBanner } from "@codecast/shared/contracts";
import { autoSwitchCheck, onFreshApiErrorPark, throttleContinueCheck } from "../../convex/convex/accountSwitch";
import { isBlockedConversation } from "../../convex/convex/ccAccountsShared";
import { makeFakeDb } from "../../convex/convex/testDb";

test("a safety failure travels through JSON-RPC into the blocked fleet without automatic recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-safety-"));
  const binary = join(dir, "fake-codex.js");
  writeFileSync(binary, `#!${process.execPath}
import { createInterface } from 'node:readline';
process.stderr.write("fixture booted\\n");
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(() => {}, 1000);
process.stdin.on('end', () => { process.stderr.write("stdin ended\\n"); process.exit(0); });
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if(r.method==='initialize') send({id:r.id,result:{}});
  if(r.method==='turn/start') {
    const turn={id:'failed-turn',status:'inProgress',items:[]};
    send({method:'turn/started',params:{threadId:'thread',turn}});
    send({id:r.id,result:{turn}});
    const item={type:'agentMessage',id:'partial',text:'Partial response'};
    send({method:'item/completed',params:{threadId:'thread',turnId:turn.id,item}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{...turn,status:'failed',items:[item],error:{codexErrorInfo:'misalignmentPolicyViolation',message:'This request was blocked by our safety systems. Reason: Potentially unintended activity.'}}}});
  }
});
`, { mode: 0o755 });
  console.error("fixture interpreter", process.execPath);
  const server = new CodexAppServer({ codexBinary: binary, log: console.error });
  server.on("error", () => {});
  try {
    const ready = once(server, "ready");
    server.start();
    await ready;
    const completed = once(server, "turnCompleted");
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "Test fixture" }] });
    const [, turnId, messages, status, error] = await completed;
    expect(status).toBe("failed");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Partial response");
    const kind = classifyApiErrorBanner(messages[1].content);
    expect(kind).toBe("safety");
    const now = Date.now();
    const conversation = { _id: "conversations_safety", user_id: "users_owner", agent_type: "codex", pending_api_error: true, pending_api_error_kind: kind, pending_api_error_at: now, updated_at: now };
    expect(isBlockedConversation(conversation)).toBe(true);
    const device = { _id: "devices_mac", user_id: "users_owner", device_id: "mac", last_seen: now, cc_auto_switch: true, cc_auto_continue: true };
    const db = makeFakeDb({ conversations: [conversation], devices: [device], daemon_commands: [], pending_messages: [] });
    const scheduled: string[] = [];
    const scheduler = { async runAfter(_ms: number, fn: any) { scheduled.push(getFunctionName(fn)); }, async runAt(_at: number, fn: any) { scheduled.push(getFunctionName(fn)); } };
    await onFreshApiErrorPark({ db, scheduler }, "users_owner" as any, kind!);
    expect(scheduled).toEqual(["accountSwitch:blockedNotifyCheck"]);
    await (autoSwitchCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
    await (throttleContinueCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
    expect(db._inserted).toEqual([]);
    let recoveryStarts = 0;
    const recovered = await recoverCodexTurn({
      record: { threadId: "thread", updatedAt: now, activeTurnId: turnId },
      thread: { id: "thread", status: { type: "systemError" }, turns: [{ id: turnId, status, error, items: [] }] } as any,
      save: record => { expect(record.activeTurnId).toBeUndefined(); },
      start: async () => { recoveryStarts++; throw new Error("Safety stop retried"); },
    });
    expect(recovered).toBe("settled");
    expect(recoveryStarts).toBe(0);
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
