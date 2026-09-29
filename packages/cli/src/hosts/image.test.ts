import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cloneResetUserData, createImageArgs, imageName } from "./image";

test("a clone makes itself its own machine once, before the daemon: new machine id, no source token, no source worktrees", () => {
  const data = cloneResetUserData("ubuntu");
  const doc = (Bun as any).YAML.parse(data.replace(/^#cloud-config\n/, ""));
  const cmd: string[] = doc.bootcmd[0];
  expect(cmd.slice(0, 3)).toEqual(["cloud-init-per", "instance", "codecast-clone-reset"]);
  const script = cmd[5]!;
  expect(spawnSync("sh", ["-n", "-c", script]).status).toBe(0);
  expect(script.indexOf("systemctl stop codecast-daemon")).toBeLessThan(script.indexOf("systemd-machine-id-setup"));
  expect(script).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
  expect(script).toContain("/home/ubuntu/.codecast/config.json");
  expect(script).toContain(".codecast/worktrees");
});

test("an image is tagged as codecast's, for its platform and source, and captured without a reboot", () => {
  const name = imageName("linux", "i-084309c56a91e15ff", new Date("2026-09-29T10:11:12Z"));
  expect(name).toBe("codecast-linux-2026-09-29-10-11-12-a91e15ff".replace("a91e15ff", "c56a91e15ff".slice(-6)));
  const args = createImageArgs("i-084309c56a91e15ff", "linux", name);
  expect(args).toContain("--no-reboot");
  const tags = JSON.parse(args[args.indexOf("--tag-specifications") + 1]!);
  expect(tags.map((t: any) => t.ResourceType)).toEqual(["image", "snapshot"]);
  expect(tags[0].Tags).toContainEqual({ Key: "managed-by", Value: "codecast" });
  expect(tags[0].Tags).toContainEqual({ Key: "codecast-source", Value: "i-084309c56a91e15ff" });
});
