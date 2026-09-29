import { forwardToHost } from "./src/cloud/hostForward.ts";
const f = await forwardToHost("28d80e225ed21f45", 34427);
console.log("PORT", f.port);
setInterval(() => {}, 1 << 30);
