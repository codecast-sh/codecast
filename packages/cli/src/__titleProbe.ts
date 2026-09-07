// TEMPORARY probe (ct-49539). Deleted before the task closes.
import "./test-helpers/isolatedTmuxServer.js";
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { startFakeModelEndpoint, spawnClientPane, deliverToPane, matrixClientAvailable, type MatrixClientId } from "./test-helpers/messagingHarness.js";
import { tmuxRun } from "./tmux.js";

const client = (process.argv[2] ?? "claude") as MatrixClientId;
const holdTurn = process.argv[3] !== "reject";
const title = (t: string): string => tmuxRun(["display-message", "-p", "-t", t, "#{pane_title}"]).stdout.replace(/\n$/, "");
const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const endpoint = await startFakeModelEndpoint();
if (!holdTurn) endpoint.reject();
if (!matrixClientAvailable(client)) { console.log(`${client}: skipped`); process.exit(0); }
const pane = spawnClientPane(client, { endpointUrl: endpoint.url });
let last = "";
const sample = (label: string): void => {
  const t = title(pane.target);
  if (t !== last) {
    console.log(`${label} state=${pane.liveState()} inFlight=${endpoint.inFlight()} title=${JSON.stringify(t)} hex=${hex(t)}`);
    last = t;
  }
};
try {
  for (let i = 0; i < 80; i++) { await sleep(250); sample(`boot+${((i + 1) * 0.25).toFixed(2)}s`); if (pane.liveState() === "idle") break; }
  await sleep(3000);
  console.log(`SETTLED-BEFORE title=${JSON.stringify(title(pane.target))} hex=${hex(title(pane.target))} state=${pane.liveState()}`);
  last = title(pane.target);
  const delivery = deliverToPane(pane, "probe payload one\nprobe payload two").catch((e) => console.log(`deliver failed: ${String(e).slice(0, 160)}`));
  for (let i = 0; i < 200; i++) { await sleep(100); sample(`work+${((i + 1) * 0.1).toFixed(1)}s`); }
  console.log(`AFTER title=${JSON.stringify(title(pane.target))} hex=${hex(title(pane.target))} state=${pane.liveState()}`);
  await delivery;
} finally {
  endpoint.reject();
  endpoint.close();
  pane.tearDown();
  killIsolatedTmuxServer();
}
process.exit(0);
