import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { CodexAppServer } from "./codexAppServer.js";
import { codexResumeParams, recoverCodexTurn, settledCodexRecord, type PersistedCodexThread } from "./codexTurnRecovery.js";

test("a killed app-server resumes persisted work once through JSON-RPC and finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-recovery-"));
  const binary = join(dir, "fake-codex.js");
  const state = join(dir, "intent.json");
  const starts = join(dir, "starts.jsonl");
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(() => {}, 1000);
process.stdin.on('end', () => process.exit(0));
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if(r.method==='initialize') send({id:r.id,result:{}});
  if(r.method==='thread/resume') {
    if(r.params.sandbox!=='danger-full-access') send({id:r.id,error:{message:'sandbox changed across restart'}});
    else send({id:r.id,result:{thread:{id:'thread',status:{type:'idle'},turns:[{id:'turn',status:'interrupted',items:[]}]},cwd:${JSON.stringify(dir)},model:'test'}});
  }
  if(r.method==='turn/start') {
    const recovery=existsSync(${JSON.stringify(starts)});
    appendFileSync(${JSON.stringify(starts)},JSON.stringify(r.params)+'\\n');
    const turn={id:recovery?'recovered':'turn',status:'inProgress',items:[]};
    send({method:'turn/started',params:{threadId:'thread',turn}});
    send({id:r.id,result:{turn}});
    if(!recovery) setTimeout(()=>process.kill(process.pid,'SIGKILL'),30);
    else {
      const item={type:'agentMessage',id:'answer',phase:'final_answer',text:'Finished the existing task'};
      send({method:'item/completed',params:{threadId:'thread',turnId:turn.id,item}});
      send({method:'turn/completed',params:{threadId:'thread',turn:{...turn,status:'completed',items:[item]}}});
    }
  }
});
`, { mode: 0o755 });
  let server: CodexAppServer | undefined;
  let saved: PersistedCodexThread = { threadId: "thread", updatedAt: 1, cwd: dir, sandbox: "danger-full-access" };
  const save = (next: PersistedCodexThread) => { saved = next; writeFileSync(state, JSON.stringify(saved)); };
  const boot = async () => {
    server = new CodexAppServer({ codexBinary: binary, log: message => console.error(message) });
    server.on("error", () => {});
    server.on("turnStarted", (_thread, turnId) => save({ ...saved, activeTurnId: turnId }));
    server.on("turnCompleted", (_thread, turnId) => save(settledCodexRecord(saved, turnId)));
    const ready = once(server, "ready");
    server.start();
    await ready;
    return server;
  };
  try {
    const first = await boot();
    const died = once(first, "exited");
    await first.turnStart({ threadId: "thread", input: [{ type: "text", text: "Existing task" }] });
    await died;
    first.stop();
    saved = JSON.parse(readFileSync(state, "utf8"));
    expect(saved.activeTurnId).toBe("turn");
    const replacement = await boot();
    const response = await replacement.threadResume(codexResumeParams(saved, "never"));
    const complete = once(replacement, "turnCompleted");
    await recoverCodexTurn({ record: saved, thread: response.thread, save, start: input => replacement.turnStart(input) });
    const [, , messages, status] = await complete;
    expect(status).toBe("completed");
    expect(messages[0].content).toBe("Finished the existing task");
    expect(JSON.parse(readFileSync(state, "utf8")).activeTurnId).toBeUndefined();
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
