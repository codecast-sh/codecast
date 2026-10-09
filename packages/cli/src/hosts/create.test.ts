import { describe, expect, test } from "bun:test";
import { createHostPlan, type CreateHostOptions } from "./create";
import { macBaseScript, macDaemonScript } from "./provisionMac";
import { kcpassword, macDesktopScript, macLoginScript, parseMacDesktop } from "./macLogin";
import { hostReleaseScript } from "./installRelease";
import { spawnSync } from "node:child_process";
import { toRemoteHost } from "../browser/cloudHost";

const options: CreateHostOptions = { name: "dev", key: "~/.ssh/dev.pem", keyName: "dev", region: "us-west-2", image: "ami-1234", subnet: "subnet-1234", securityGroup: "sg-1234", disk: "80" };

describe("remote machine launch", () => {
  test("Linux launches one machine with IMDSv2, stop on shutdown, and a repeatable request token", () => {
    const plan = createHostPlan("linux", options);
    expect(plan.type).toBe("t3.medium");
    expect(plan.args).toContain("HttpTokens=required,HttpEndpoint=enabled");
    expect(plan.args).toContain("--associate-public-ip-address");
    expect(JSON.parse(plan.args[plan.args.indexOf("--tag-specifications") + 1]!)[0].Tags).toContainEqual({ Key: "codecast-launch-token", Value: plan.clientToken });
    expect(plan.args[plan.args.indexOf("--count") + 1]).toBe("1");
    expect(plan.args.at(-1)).toBe(createHostPlan("linux", options).args.at(-1));
    expect(plan.args.at(-1)).not.toBe(createHostPlan("linux", { ...options, name: "other" }).args.at(-1));
  });
  test("Mac requires an explicitly allocated host and names the continuing cost", () => {
    expect(() => createHostPlan("mac", options)).toThrow("--dedicated-host");
    const plan = createHostPlan("mac", { ...options, dedicatedHost: "h-1234" });
    expect(plan.platform).toBe("darwin");
    expect(plan.args).toContain("Tenancy=host,HostId=h-1234");
    expect(plan.billing).toContain("24-hour");
    expect(() => createHostPlan("linux", { ...options, type: "mac2.metal" })).toThrow("match");
    expect(() => createHostPlan("linux", { ...options, disk: "NaN" })).toThrow("Disk size");
  });
  test("AWS Mac and legacy Mac paths use the remote macOS home", () => {
    const host = { id: "i-1", provider: "aws" as const, region: "us-east-2", user: "ec2-user", keyPath: "/key", address: "1.2.3.4" };
    expect(toRemoteHost(host).homeDir).toBe("/home/ec2-user");
    expect(toRemoteHost({ ...host, platform: "darwin" }).remoteBaseDir).toBe("/Users/ec2-user/work");
    expect(toRemoteHost({ ...host, provider: "scaleway-mac", user: "m1" }).homeDir).toBe("/Users/m1");
  });
  test("Mac setup scripts parse and start an unattended remote daemon without idle shutdown", () => {
    for (const script of [macBaseScript(), macLoginScript("codecast"), macDesktopScript("codecast"), macDaemonScript({ user: "ec2-user", homeDir: "/Users/ec2-user" }), hostReleaseScript("linux"), hostReleaseScript("darwin")]) {
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    const script = macDaemonScript({ user: "ec2-user", homeDir: "/Users/ec2-user" });
    expect(script).toContain("launchctl bootstrap system");
    expect(script).toContain("launchctl kickstart -k system/sh.codecast.remote.ec2-user");
    expect(script).toContain("CODECAST_REMOTE_DEVICE");
    expect(script).not.toContain("shutdown");
    expect(() => macDaemonScript({ user: "bad'user" })).toThrow("unsupported");
    expect(() => macLoginScript("bad'user")).toThrow("username");
    expect(macLoginScript("codecast")).toContain("already exists and is not managed by Codecast");
  });
  test("the desktop login's kcpassword is the bytes loginwindow decodes", () => {
    expect(kcpassword("password").toString("hex")).toBe("0de82150a5d3af8ea3b91f7d");
    expect(kcpassword("exactly-twelv").length).toBe(24);
    const script = macDesktopScript("codecast", "pw-1");
    expect(script).toContain(`echo '${kcpassword("pw-1").toString("base64")}' | base64 -D`);
    expect(script).toContain("autoLoginUser \"$user\"");
    expect(() => macDesktopScript("codecast", "it's")).toThrow("password");
    expect(() => macDesktopScript("bad'user")).toThrow("username");
  });
  test("desktop setup reports where the login stands", () => {
    expect(parseMacDesktop("MAC-DESKTOP-PREVIOUS ec2-user\nMAC-DESKTOP-AT-BOOT")).toEqual({ desktop: "at-boot", previous: "ec2-user" });
    expect(parseMacDesktop("MAC-DESKTOP-LIVE")).toEqual({ desktop: "live", previous: null });
    expect(parseMacDesktop("MAC-DESKTOP-PASSWORD-UNKNOWN").desktop).toBe("password-unknown");
    expect(() => parseMacDesktop("boom")).toThrow("did not finish");
  });
});
