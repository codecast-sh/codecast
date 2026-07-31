// Standalone vault bridge for web development: the /vault/* routes + WS on a
// fixed port with a fixed token, no daemon required. Pair with the browser dev
// override (lib/terminal/endpoint.ts):
//   localStorage.CAST_TERM_ENDPOINT = "<port>:<token>"
// Usage: bun packages/cli/scripts/vault-dev-server.ts [port] [token]
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleVaultHttp, attachVaultServer, type VaultServerOptions } from "../src/vault/vaultServer";

const port = parseInt(process.argv[2] ?? "9877", 10);
const token = process.argv[3] ?? "vault-dev-token";

const opts: VaultServerOptions = {
  token,
  log: (msg) => console.log(`[vault-dev] ${msg}`),
  configDir: path.join(os.homedir(), ".codecast"),
};

const server = http.createServer((req, res) => {
  if (handleVaultHttp(req, res, opts)) return;
  res.writeHead(404).end("vault dev server: /vault/* only");
});
attachVaultServer(server, opts);
server.listen(port, "127.0.0.1", () => {
  console.log(`[vault-dev] listening on 127.0.0.1:${port} (token: ${token})`);
  console.log(`[vault-dev] browser override: localStorage.CAST_TERM_ENDPOINT = "${port}:${token}"`);
});
