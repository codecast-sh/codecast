import { expect, test } from "bun:test";
import { MCP_CALLER_IP_HEADER, MCP_CALLER_SIG_HEADER, verifyCallerAddress } from "@codecast/shared/contracts/agentAccess";
import { mcpForwardHeaders } from "./mcpForward";

test("forwarding drops inbound copies of the caller headers and signs Cloudflare's address", async () => {
  const inbound = new Headers({
    host: "codecast.sh",
    authorization: "Bearer t",
    "cf-connecting-ip": "203.0.113.9",
    [MCP_CALLER_IP_HEADER]: "6.6.6.6",
    [MCP_CALLER_SIG_HEADER]: "forged",
  });
  const out = await mcpForwardHeaders(inbound, "s3cret");
  expect(out.get("host")).toBeNull();
  expect(out.get("authorization")).toBe("Bearer t");
  expect(out.get(MCP_CALLER_IP_HEADER)).toBe("203.0.113.9");
  expect(await verifyCallerAddress("s3cret", "203.0.113.9", out.get(MCP_CALLER_SIG_HEADER)!)).toBe(true);
});

test("without a secret or a Cloudflare address, no caller headers go out at all", async () => {
  const forged = new Headers({ [MCP_CALLER_IP_HEADER]: "6.6.6.6", [MCP_CALLER_SIG_HEADER]: "x", "cf-connecting-ip": "203.0.113.9" });
  const noSecret = await mcpForwardHeaders(forged, undefined);
  expect(noSecret.get(MCP_CALLER_IP_HEADER)).toBeNull();
  expect(noSecret.get(MCP_CALLER_SIG_HEADER)).toBeNull();
  const noCf = await mcpForwardHeaders(new Headers({ [MCP_CALLER_IP_HEADER]: "6.6.6.6" }), "s3cret");
  expect(noCf.get(MCP_CALLER_IP_HEADER)).toBeNull();
});
