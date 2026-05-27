import { getConfig } from "./api";
const cfg = getConfig();
async function post(pathname: string, body: any) {
  const r = await fetch(`${cfg.convex_url}${pathname}`, {
    method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body)
  });
  const t = await r.text();
  return `${r.status} ${t.slice(0,200)}`;
}
console.log("feedForCLI query:", await post("/api/query", {path:"conversations:feedForCLI", args:{api_token:cfg.auth_token, limit:3}, format:"json"}));
console.log("listConversations? try getUserConversations:", await post("/api/query", {path:"conversations:getRecentConversations", args:{api_token:cfg.auth_token, limit:3}, format:"json"}));
console.log("http /cli/feed:", await post("/cli/feed", {api_token:cfg.auth_token, limit:3, project_path:"/Users/ashot/src/codecast"}));
