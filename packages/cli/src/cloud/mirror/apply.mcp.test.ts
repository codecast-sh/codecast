import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REFERENCES_SNIPPET, SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import {
  GITCONFIG_BLOCK_END, GITCONFIG_BLOCK_START, MIRROR_LOCK_REL, MIRROR_RECEIVER_CAPABILITIES, MIRROR_STAMP_REL, applyMirrorBundle, applyStagingBundle,
  adoptFeatureSwitches, composeInstructionFile, featureSwitches, mergeClaudeSettings, mergeCodexHooks, mergeCodexToml, mergeGitconfig, mirrorUntouchedInCheckoutScript, readStamp, stripGitconfigBlock, verifyMirrorStamp, withMirrorLock,
} from "./apply";
import { buildMirrorBundle, parseMirrorBundle, sha256, type BundleInput } from "./bundle";
import { ownedSectionSpecs, stripOwnedSections } from "./transform";

import { HOST_CODEX_HOOKS, HOST_CODEX_TOML, HOST_SETTINGS, apply, bundleOf, home, hostClaudeMd, laptopEntries, laptopUserMd, modeOf, ownedCount, read, refresh, refreshRuns, seedHost, source, write, useHostHome } from "./apply.testkit";

useHostHome();

test("portable MCP edits and removals preserve unrelated host MCP and trust", async () => {
  seedHost();
  write('.codex/config.toml', HOST_CODEX_TOML + '\n[mcp_servers.host]\ncommand = "host-tool"\n');
  const file = (text: string) => [{ path: '.codex/config.toml', kind: 'codex-toml' as const, mode: '0600' as const, bytes: Buffer.from(text) }];
  await apply(await bundleOf(file('[mcp_servers.local]\ncommand = "first"\n')));
  expect(read('.codex/config.toml')).toContain('command = "host-tool"');
  await apply(await bundleOf(file('[mcp_servers.local]\ncommand = "second"\n')));
  expect(read('.codex/config.toml')).toContain('command = "second"');
  await apply(await bundleOf(file('model = "next"\n')));
  expect(read('.codex/config.toml')).not.toContain('[mcp_servers.local]');
  expect(read('.codex/config.toml')).toContain('command = "host-tool"');
  expect(read('.codex/config.toml')).toContain('trust_level = "trusted"');
});

test("removed instruction aliases delete only their link and dangling tombstones report drift", async () => {
  write(".claude/AGENTS.md", "rules\n");
  fs.symlinkSync("AGENTS.md", path.join(home, ".claude/CLAUDE.md"));
  const entries: BundleInput[] = [
    { path: ".claude/AGENTS.md", kind: "agents-md", mode: "0600", bytes: Buffer.from("rules\n") },
    { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from("rules\n") },
  ];
  expect((await apply(await bundleOf(entries))).errors).toEqual([]);
  const removed = await apply(await bundleOf(entries.slice(0, 1)));
  expect(removed.pruned).toEqual([".claude/CLAUDE.md"]);
  expect(fs.lstatSync(path.join(home, ".claude/CLAUDE.md"), { throwIfNoEntry: false })).toBeUndefined();
  expect(read(".claude/AGENTS.md")).toBe("rules\n");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  fs.symlinkSync("missing.md", path.join(home, ".claude/CLAUDE.md"));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const drifted = await apply(await bundleOf(entries.slice(0, 1)));
  expect(drifted.host_edited).toEqual([".claude/CLAUDE.md"]);
  expect(readStamp(home)?.complete).toBe(false);
  expect(fs.readlinkSync(path.join(home, ".claude/CLAUDE.md"))).toBe("missing.md");
});

test("host MCP disabled pins keep canonical fields fresh, then command changes and pin removal recover without conflict", async () => {
  const { emptyOverrides, reconcilePins, readHostMcpOverrides, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  seedHost();
  const definition = (command: string, timeout = 10) => `[mcp_servers."computer.ui"]\ncommand = "${command}"\nenabled = true\nstartup_timeout_sec = ${timeout}\n`;
  const file = (text: string): BundleInput[] => [{ path: ".codex/config.toml", kind: "codex-toml", mode: "0600", bytes: Buffer.from(text) }];
  const initial = await bundleOf(file(definition("mac-only")));
  expect((await apply(initial)).errors).toEqual([]);
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "codex", [{ name: "computer.ui", command: "mac-only", status: "unsupported" }], "now"));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const disabled = await apply(initial);
  expect(disabled.host_edited).toEqual([]);
  expect(disabled.errors).toEqual([]);
  expect(read(".codex/config.toml")).toContain("enabled = false");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  const updated = await apply(await bundleOf(file(definition("mac-only", 30))));
  expect(updated.host_edited).toEqual([]);
  expect(updated.errors).toEqual([]);
  expect(read(".codex/config.toml")).toContain("startup_timeout_sec = 30");
  expect(read(".codex/config.toml")).toContain("enabled = false");
  const portable = await apply(await bundleOf(file(definition("portable"))));
  expect(portable.host_edited).toEqual([]);
  expect(portable.errors).toEqual([]);
  expect(readHostMcpOverrides(home).codex).toEqual({});
  expect(read(".codex/config.toml")).toContain("enabled = true");
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "codex", [{ name: "computer.ui", command: "portable", status: "unsupported" }], "now"));
  await apply(await bundleOf(file(definition("portable"))));
  writeHostMcpOverrides(home, emptyOverrides());
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const recovered = await apply(await bundleOf(file(definition("portable"))));
  expect(recovered.errors).toEqual([]);
  expect(recovered.host_edited).toEqual([]);
  expect(read(".codex/config.toml")).toContain("enabled = true");
  expect(read(".codex/config.toml")).toContain("trust_level");
});

test("Claude MCP pins omit the consumed server definition rather than inventing an enabled property", async () => {
  const { emptyOverrides, reconcilePins, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "claude", [{ name: "mac", command: "mac-only", status: "unsupported" }], "now"));
  const result = await apply(await bundleOf([{ path: ".claude/.mcp.json", kind: "json-remap", mode: "0600", bytes: Buffer.from(JSON.stringify({ mcpServers: { mac: { command: "mac-only" }, portable: { command: "linux-tool" } } })) }]));
  expect(result.errors).toEqual([]);
  expect(JSON.parse(read(".claude/.mcp.json"))).toEqual({ mcpServers: { portable: { command: "linux-tool" } } });
});

test("selective Claude MCP ownership updates and removes definitions while preserving host login, trust and edits", async () => {
  const root = path.join(home, "work/app");
  const local = { command: "portable-tool", args: ["first"] };
  const initialHost = { oauthAccount: { accessToken: "fixture-host-auth" }, numStartups: 17, mcpServers: { host: { command: "host-tool" } }, projects: { [root]: { hasTrustDialogAccepted: true, mcpServers: { host: { command: "project-host-tool" } } } } };
  write(".claude.json", JSON.stringify(initialHost));
  const file = (value: unknown): BundleInput[] => [{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify(value)) }];
  const first = { mcpServers: { local }, projects: { [root]: { mcpServers: { local } } } };
  expect((await apply(await bundleOf(file(first)))).errors).toEqual([]);
  expect(JSON.parse(read(".claude.json"))).toMatchObject(initialHost);
  const next = { mcpServers: { local: { command: "portable-tool", args: ["second"] } } };
  const updated = await apply(await bundleOf(file(next)));
  expect(updated.host_edited).toEqual([]);
  expect(updated.errors).toEqual([]);
  expect(JSON.parse(read(".claude.json")).projects[root]).toEqual(initialHost.projects[root]);
  const edited = JSON.parse(read(".claude.json"));
  edited.mcpServers.local.args = ["remote edit"];
  write(".claude.json", JSON.stringify(edited));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const conflict = await apply(await bundleOf(file({ mcpServers: { local: { command: "portable-tool", args: ["third"] } } })));
  expect(conflict.host_edited).toEqual([".claude.json"]);
  expect(JSON.parse(read(".claude.json")).mcpServers.local.args).toEqual(["remote edit"]);
  expect(readStamp(home)?.complete).toBe(false);
  edited.mcpServers.local.args = ["third"];
  write(".claude.json", JSON.stringify(edited));
  expect((await apply(await bundleOf(file({ mcpServers: { local: { command: "portable-tool", args: ["third"] } } })))).host_edited).toEqual([]);
  expect((await apply(await bundleOf([]))).errors).toEqual([]);
  expect(JSON.parse(read(".claude.json"))).toEqual(initialHost);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  expect(readStamp(home)?.files[".claude.json"]?.source).not.toContain("fixture-host-auth");
});

test("Claude global and project pins mask only matching commands and recover when removed or changed", async () => {
  const { emptyOverrides, reconcilePins, readHostMcpOverrides, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  const root = path.join(home, "work/app");
  const value = (command = "mac-only", timeout = 10) => ({ mcpServers: { mac: { command, timeout } }, projects: { [root]: { mcpServers: { mac: { command: "portable" } } } } });
  const file = (projection: unknown): BundleInput[] => [{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify(projection)) }];
  const pins = reconcilePins(emptyOverrides(), "claude", [{ name: "mac", command: "mac-only", status: "unsupported" }], "now");
  expect((await apply(await bundleOf(file(value())))).errors).toEqual([]);
  writeHostMcpOverrides(home, pins);
  const disabled = await apply(await bundleOf(file(value("mac-only", 20))));
  expect(disabled.errors).toEqual([]);
  expect(disabled.host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac).toBeUndefined();
  expect(JSON.parse(read(".claude.json")).projects[root].mcpServers.mac.command).toBe("portable");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  writeHostMcpOverrides(home, emptyOverrides());
  expect((await apply(await bundleOf(file(value("mac-only", 30))))).host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac.timeout).toBe(30);
  writeHostMcpOverrides(home, pins);
  expect((await apply(await bundleOf(file(value())))).errors).toEqual([]);
  const changed = await apply(await bundleOf(file(value("linux-tool"))));
  expect(changed.errors).toEqual([]);
  expect(changed.host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac.command).toBe("linux-tool");
  expect(readHostMcpOverrides(home).claude).toEqual({});
});

test("Claude MCP freshness ignores host startup state and unrelated MCP fields but detects owned drift", async () => {
  const root = path.join(home, "work/app");
  const server = { command: "portable", args: ["--root", root], env: { PORTABLE_SETTING: "one" } };
  const bundle = await bundleOf([{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify({ mcpServers: { local: server }, projects: { [root]: { mcpServers: { project: server } } } })) }]);
  expect((await apply(bundle)).errors).toEqual([]);
  const fingerprint = readStamp(home)!.files[".claude.json"]!.written;
  const host = JSON.parse(read(".claude.json"));
  host.oauthAccount = { accessToken: "fixture-host-login" };
  host.numStartups = 20;
  host.history = ["host session"];
  host.projects[root].hasTrustDialogAccepted = true;
  host.projects[path.join(home, "other")] = { hasTrustDialogAccepted: true, mcpServers: { host: { command: "host-tool" } } };
  host.mcpServers.host = { command: "host-tool" };
  host.mcpServers.local.hostSetting = "host-specific";
  host.mcpServers.local.env.HOST_SETTING = "host-specific";
  host.projects[root].mcpServers.host = { command: "host-tool" };
  host.mcpServers.local = Object.fromEntries(Object.entries(host.mcpServers.local).reverse());
  write(".claude.json", JSON.stringify(host, null, 4));
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  expect(verifyMirrorStamp(home)?.hash).toBe(bundle.hash);
  const repeat = await apply(bundle);
  expect(repeat.host_edited).toEqual([]);
  expect(repeat.errors).toEqual([]);
  expect(readStamp(home)!.files[".claude.json"]!.written).toBe(fingerprint);
  expect(JSON.parse(read(".claude.json"))).toEqual(host);
  for (const change of [
    (value: any) => { value.mcpServers.local.command = "remote-edit"; },
    (value: any) => { delete value.mcpServers.local; },
    (value: any) => { value.projects[root].mcpServers.project.args = ["changed"]; },
    (value: any) => { delete value.projects[root].mcpServers.project.env.PORTABLE_SETTING; },
    (value: any) => { value.projects[root].mcpServers = null; },
  ]) {
    const changed = structuredClone(host);
    change(changed);
    write(".claude.json", JSON.stringify(changed));
    expect(verifyMirrorStamp(home)?.complete).toBe(false);
  }
  write(".claude.json", JSON.stringify(host));
  fs.chmodSync(path.join(home, ".claude.json"), 0o644);
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  fs.chmodSync(path.join(home, ".claude.json"), 0o600);
  write(".claude.json", "not JSON");
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
});

test("Claude MCP deleted fields stay verified after unrelated host changes and repeated empty bundles", async () => {
  const file = (value: unknown): BundleInput[] => [{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify(value)) }];
  const initial = { mcpServers: { local: { command: "portable", args: ["old"] } } };
  expect((await apply(await bundleOf(file(initial)))).errors).toEqual([]);
  const next = await bundleOf(file({ mcpServers: { local: { command: "portable" } } }));
  expect((await apply(next)).errors).toEqual([]);
  const host = JSON.parse(read(".claude.json"));
  host.numStartups = 2;
  host.mcpServers.local.hostSetting = true;
  write(".claude.json", JSON.stringify(host));
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  host.mcpServers.local.args = ["reappeared"];
  write(".claude.json", JSON.stringify(host));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(next)).host_edited).toEqual([".claude.json"]);
  expect(JSON.parse(read(".claude.json")).mcpServers.local.args).toEqual(["reappeared"]);
  delete host.mcpServers.local.args;
  write(".claude.json", JSON.stringify(host));
  expect((await apply(next)).host_edited).toEqual([]);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  const empty = await bundleOf([]);
  expect((await apply(empty)).errors).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.local).toEqual({ hostSetting: true });
  const retired = JSON.parse(read(".claude.json"));
  retired.numStartups++;
  retired.mcpServers.host = { command: "host-tool" };
  write(".claude.json", JSON.stringify(retired));
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  retired.mcpServers.local.command = "returned";
  write(".claude.json", JSON.stringify(retired));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(empty)).host_edited).toEqual([".claude.json"]);
  delete retired.mcpServers.local.command;
  write(".claude.json", JSON.stringify(retired));
  expect((await apply(empty)).host_edited).toEqual([]);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
});

test("empty mirrored MCP objects do not claim future host children", async () => {
  const bundle = await bundleOf([{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from('{"mcpServers":{"local":{"command":"portable","env":{}}}}') }]);
  expect((await apply(bundle)).errors).toEqual([]);
  const host = JSON.parse(read(".claude.json"));
  host.mcpServers.local.env.HOST_ONLY = "one";
  write(".claude.json", JSON.stringify(host));
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  expect((await apply(bundle)).host_edited).toEqual([]);
  expect((await apply(await bundleOf([]))).errors).toEqual([]);
  const removed = JSON.parse(read(".claude.json"));
  expect(removed.mcpServers.local).toEqual({ env: { HOST_ONLY: "one" } });
  removed.mcpServers.local.env.HOST_ONLY = "two";
  write(".claude.json", JSON.stringify(removed));
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
});

test("legacy whole-file Claude MCP stamps migrate on apply and ignore auth churn during refresh", async () => {
  const bundle = await bundleOf([{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from('{"mcpServers":{"local":{"command":"portable"}}}') }]);
  expect((await apply(bundle)).errors).toEqual([]);
  const legacy = readStamp(home)!;
  delete legacy.files[".claude.json"]!.mcp_fields;
  legacy.files[".claude.json"]!.written = sha256(read(".claude.json"));
  write(MIRROR_STAMP_REL, JSON.stringify(legacy));
  const host = JSON.parse(read(".claude.json"));
  host.oauthAccount = { accessToken: "fixture-host-token" };
  write(".claude.json", JSON.stringify(host));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const migrated = await apply(bundle, { refresh: () => {
    const current = JSON.parse(read(".claude.json"));
    current.numStartups = 12;
    write(".claude.json", JSON.stringify(current));
  } });
  expect(migrated.errors).toEqual([]);
  expect(migrated.host_edited).toEqual([]);
  expect(readStamp(home)!.files[".claude.json"]!.mcp_fields).toEqual([["mcpServers", "local", "command"]]);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  const changed = await apply(bundle, { refresh: () => {
    const current = JSON.parse(read(".claude.json"));
    current.mcpServers.local.command = "changed during boot";
    write(".claude.json", JSON.stringify(current));
  } });
  expect(changed.errors).toEqual([{ path: ".claude.json", error: "mirrored MCP content changed during refresh" }]);
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
});
