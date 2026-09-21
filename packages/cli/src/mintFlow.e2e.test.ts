import "./test-helpers/isolatedTmuxServer";
import { expect, test } from "bun:test";
import { tmuxRun } from "./tmux";
import { shellQuote, spawnTmuxPane } from "./test-helpers/tmuxPane";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptProviderKey } from "../../web/lib/providerKeyCrypto";
import { getProviderKeyPublicKey, decryptProviderKeyPayload } from "./providerKeyCrypto";
import { submitMintApprovalCode } from "./mintFlowControl";
import { extractSetupToken } from "./ccAccounts";
import { requestMintToken, submitMintCode, reportMintFlow } from "../../convex/convex/accountSwitch";
import { makeFakeDb } from "../../convex/convex/testDb";

test("browser code crosses the command transport and finishes a real terminal approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-mint-e2e-"));
  const target = `mint-e2e-${process.pid}`;
  const exec = async (args: string[]) => {
    const result = tmuxRun(args);
    if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
    return result;
  };
  const expectedToken = `sk-ant-oat01-${"fixture".repeat(10)}`;
  const device: any = { _id: "devices_mini", user_id: "users_owner", device_id: "mini", last_seen: Date.now(),
    cc_accounts: { profiles: [{ name: "work", email: "work@example.com" }] } };
  const tables = { devices: [device], daemon_commands: [] as any[] };
  const ctx = { db: makeFakeDb(tables), auth: { getUserIdentity: async () => ({ subject: "users_owner|session" }) } };
  try {
    const script = join(dir, "approve.sh");
    writeFileSync(script, `printf 'READY\\n'\nIFS= read -r code\n[ "$code" = 'fixture_code#state' ] || exit 2\nprintf '%s\\n' '${expectedToken}'\nsleep 15\n`, { mode: 0o700 });
    spawnTmuxPane({ session: target, cwd: dir, body: `exec /bin/sh ${shellQuote(script)}` });
    for (let i = 0; i < 20; i++) {
      if ((await exec(["capture-pane", "-p", "-t", target])).stdout.includes("READY")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const started = await (requestMintToken as any)._handler(ctx, { device_id: "mini", profile: "work" });
    const payload = await encryptProviderKey(getProviderKeyPublicKey(dir), "claude-mint-code", "fixture_code#state");
    await (submitMintCode as any)._handler(ctx, { device_id: "mini", started_at: started.started_at, payload });
    const command = JSON.parse(tables.daemon_commands.at(-1).args);
    expect(JSON.stringify(command)).not.toContain("fixture_code");
    const calls: string[][] = [];
    await submitMintApprovalCode(async args => { calls.push(args); return exec(args); }, target, decryptProviderKeyPayload(dir, command.mint_code));
    expect(calls.flat().join(" ")).not.toContain("fixture_code");
    let token: string | null = null;
    let pane = "";
    for (let i = 0; i < 20 && !token; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      pane = (await exec(["capture-pane", "-p", "-J", "-t", target])).stdout;
      token = extractSetupToken(pane);
    }
    if (!token) throw new Error(`Terminal output: ${JSON.stringify(pane)}`);
    expect(token).toBe(expectedToken);
    await (reportMintFlow as any)._handler(ctx, { device_id: "mini", started_at: command.mint_started_at, status: "confirmed", profile: "work" });
    expect(device.cc_mint_flow.status).toBe("confirmed");
  } finally {
    await exec(["kill-session", "-t", target]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
