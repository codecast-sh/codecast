import { describe, expect, test } from "bun:test";
import type { CloudHost } from "../../browser/cloudHost";
import { codecastMachine, CodecastMachineError } from "../../browser/codecastMachine";
import { managedHost } from "./managedHost";

describe("managedHost", () => {
  test("first run: launches, registers as a codecast host, provisions", async () => {
    const reg: CloudHost[] = [];
    const provisioned: string[] = [];
    const sent: string[] = [];
    const h = await managedHost(() => {}, {
      hosts: () => reg,
      upsert: (x) => reg.push(x),
      key: () => ({ path: "/k/id_ed25519", pub: "ssh-ed25519 AAAA me" }),
      request: (pub) => { sent.push(pub); return { instance_id: "i-0abc", Reservations: [{ Instances: [{ InstanceId: "i-0abc", State: { Name: "pending" } }] }] }; },
      provision: async (id) => { provisioned.push(id); },
    });
    expect(sent).toEqual(["ssh-ed25519 AAAA me"]);
    expect(h).toMatchObject({ id: "i-0abc", provider: "codecast", user: "ubuntu", keyPath: "/k/id_ed25519", platform: "linux" });
    expect(provisioned).toEqual(["i-0abc"]);
  });

  test("later runs reuse the registered machine and launch nothing", async () => {
    const mine: CloudHost = { id: "i-0abc", provider: "codecast", region: "us-west-2", user: "ubuntu", keyPath: "/k" };
    const h = await managedHost(() => {}, {
      hosts: () => [{ ...mine, id: "i-other", provider: "aws" }, mine],
      request: () => { throw new Error("must not launch"); },
    });
    expect(h.id).toBe("i-0abc");
  });
});

describe("codecastMachine", () => {
  const config = { auth_token: "tok", convex_url: "https://x.convex.cloud" };
  test("posts the op with the token to the site URL and returns the answer", () => {
    let seen: { url: string; body: any } | undefined;
    const r = codecastMachine("describe", {}, { config, post: (url, body) => { seen = { url, body: JSON.parse(body) }; return { status: 200, text: JSON.stringify({ Reservations: [] }) }; } });
    expect(seen).toEqual({ url: "https://x.convex.site/cli/cast/env-machine", body: { api_token: "tok", op: "describe" } });
    expect(r).toEqual({ Reservations: [] });
  });

  test("the backend's reason becomes the error", () => {
    expect(() => codecastMachine("start", {}, { config, post: () => ({ status: 503, text: JSON.stringify({ error: "all 10 cast cloud machines are in use right now" }) }) }))
      .toThrow(new CodecastMachineError("all 10 cast cloud machines are in use right now"));
    expect(() => codecastMachine("start", {}, { config: null })).toThrow(/cast login/);
  });
});
