import * as http from "node:http";
import { handleTerminalHttp } from "./src/terminal/terminalServer.ts";
const srv = http.createServer((req, res) => {
  if (!handleTerminalHttp(req, res, { token: "devtok-screen-test", log: (m) => console.log(m), allowOrigin: (o) => o === "http://localhost:3200" })) { res.writeHead(404); res.end(); }
});
srv.listen(0, "127.0.0.1", () => console.log("PORT", (srv.address() as any).port));
