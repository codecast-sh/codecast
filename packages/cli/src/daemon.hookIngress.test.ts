// LOCAL-02. /hook/status and /hook/statusline take a secret now, and a refused
// request must reach no effect at all.
//
// These drive the REAL route (handleHookIngressHttp, the function the daemon's
// request handler calls) with inert delivery. What is asserted is what the
// route DID, not what it answered: a 401 that still delivered would pass a
// status-code test and fail this one.

import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import { handleHookIngressHttp, type HookStatusData } from "./daemon.js";
import { admitHookRequest } from "./hookAdmission.js";

const TOKEN = "a".repeat(64);

function fakeReq(url: string, headers: Record<string, string> = {}, method = "GET"): http.IncomingMessage {
  let resumed = false;
  return {
    url,
    method,
    headers,
    resume() {
      resumed = true;
    },
    get didResume() {
      return resumed;
    },
  } as unknown as http.IncomingMessage;
}

function fakeRes(): http.ServerResponse & { status: number | null; body: string } {
  const res = {
    status: null as number | null,
    body: "",
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      return res;
    },
  };
  return res as unknown as http.ServerResponse & { status: number | null; body: string };
}

function harness(opts: { token?: string; legacy?: boolean } = {}) {
  const delivered: Array<{ sessionId: string; data: HookStatusData }> = [];
  const statusLined: number[] = [];
  const refused: string[] = [];
  const deps = {
    admit: (req: http.IncomingMessage) =>
      admitHookRequest(req.headers, { token: opts.token ?? TOKEN, legacyAllowed: () => opts.legacy ?? false }),
    refuse: (_route: string, reason: string, res: http.ServerResponse) => {
      refused.push(reason);
      res.writeHead(401);
      res.end("unauthorized");
    },
    deliver: (sessionId: string, data: HookStatusData) => {
      delivered.push({ sessionId, data });
      return "delivered" as const;
    },
    statusLine: (_req: http.IncomingMessage, res: http.ServerResponse) => {
      statusLined.push(1);
      res.writeHead(200);
      res.end("ok");
    },
  };
  return { deps, delivered, statusLined, refused };
}

const STATUS_URL =
  "/hook/status?session_id=9f8c1e2a-4b6d-4f31-9c0a-1b2c3d4e5f60&status=idle&ts=1700000000" +
  "&transcript_path=%2Fetc%2Fpasswd";

describe("hook ingress admission", () => {
  test("an unauthenticated status post delivers nothing", () => {
    const h = harness();
    const res = fakeRes();
    expect(handleHookIngressHttp(fakeReq(STATUS_URL), res, h.deps)).toBe(true);
    expect(res.status).toBe(401);
    expect(h.delivered).toEqual([]);
    expect(h.refused).toEqual(["no-token"]);
  });

  test("a wrong token delivers nothing, legacy grace or not", () => {
    for (const legacy of [false, true]) {
      const h = harness({ legacy });
      const res = fakeRes();
      handleHookIngressHttp(fakeReq(STATUS_URL, { authorization: `Bearer ${"b".repeat(64)}` }), res, h.deps);
      expect(res.status).toBe(401);
      expect(h.delivered).toEqual([]);
      expect(h.refused).toEqual(["bad-token"]);
    }
  });

  test("a token of the wrong length is refused without a timing-unsafe compare", () => {
    const h = harness();
    const res = fakeRes();
    handleHookIngressHttp(fakeReq(STATUS_URL, { authorization: "Bearer short" }), res, h.deps);
    expect(res.status).toBe(401);
    expect(h.delivered).toEqual([]);
  });

  test("a real hook delivers once", () => {
    const h = harness();
    const res = fakeRes();
    handleHookIngressHttp(fakeReq(STATUS_URL, { authorization: `Bearer ${TOKEN}` }), res, h.deps);
    expect(res.status).toBe(200);
    expect(h.delivered.length).toBe(1);
    expect(h.delivered[0]!.data.status).toBe("idle");
  });

  test("a hook script from before the token is still believed while the grace holds", () => {
    const h = harness({ legacy: true });
    const res = fakeRes();
    handleHookIngressHttp(fakeReq(STATUS_URL), res, h.deps);
    expect(res.status).toBe(200);
    expect(h.delivered.length).toBe(1);
  });

  test("an unsafe session id still delivers nothing, even authenticated", () => {
    const h = harness();
    const res = fakeRes();
    handleHookIngressHttp(
      fakeReq("/hook/status?session_id=..%2Fconfig&status=idle&ts=1", { authorization: `Bearer ${TOKEN}` }),
      res,
      h.deps,
    );
    expect(res.status).toBe(400);
    expect(h.delivered).toEqual([]);
  });

  test("an unauthenticated statusline post is never parsed", () => {
    const h = harness();
    const req = fakeReq("/hook/statusline?account=x", {}, "POST");
    const res = fakeRes();
    expect(handleHookIngressHttp(req, res, h.deps)).toBe(true);
    expect(res.status).toBe(401);
    expect(h.statusLined).toEqual([]);
    expect((req as unknown as { didResume: boolean }).didResume).toBe(true);
  });

  test("an authenticated statusline post reaches the ingest", () => {
    const h = harness();
    const res = fakeRes();
    handleHookIngressHttp(
      fakeReq("/hook/statusline?account=x", { authorization: `Bearer ${TOKEN}` }, "POST"),
      res,
      h.deps,
    );
    expect(h.statusLined.length).toBe(1);
  });

  test("an empty daemon token authenticates nobody", () => {
    const h = harness({ token: "" });
    const res = fakeRes();
    handleHookIngressHttp(fakeReq(STATUS_URL, { authorization: "Bearer " }), res, h.deps);
    expect(res.status).toBe(401);
    expect(h.delivered).toEqual([]);
  });

  test("routes it does not own are left alone", () => {
    const h = harness();
    expect(handleHookIngressHttp(fakeReq("/health"), fakeRes(), h.deps)).toBe(false);
    expect(handleHookIngressHttp(fakeReq("/vault/file?x=1"), fakeRes(), h.deps)).toBe(false);
  });
});
