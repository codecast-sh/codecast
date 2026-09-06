import { WorkerHost } from "../host.js";
const host = new WorkerHost("probe", { invocation: { command: process.execPath, args: [process.argv[2], "_worker", "probe"] } });
void host.request("read", { operation: "ps", args: ["aux"], options: { env: { ...process.env, PATH: process.argv[3] }, timeout: 30000 } }, { timeoutMs: 30000 }).catch(() => {});
process.stdout.write(JSON.stringify({ workerPid: host.state.pid }) + "\n");
process.on("SIGTERM", () => { host.close(); process.exit(0); });
setInterval(() => {}, 1000);
