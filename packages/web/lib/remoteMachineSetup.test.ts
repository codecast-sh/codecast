import { describe, expect, test } from "bun:test";
import { remoteMachineSetupCommand, type RemoteMachineSetup } from "./remoteMachineSetup";

const form: RemoteMachineSetup = { platform: "linux", mode: "existing", instance: "i-1234", region: "us-west-2", profile: "", key: "~/.ssh/my key.pem", name: "dev", image: "ami-1234", keyName: "dev", subnet: "subnet-1234", securityGroup: "sg-1234", dedicatedHost: "" };

test("existing machine setup includes provisioning and quotes shell inputs", () => {
  expect(remoteMachineSetupCommand(form)).toBe("cast hosts add 'i-1234' --provision --region 'us-west-2' --key '~/.ssh/my key.pem'");
  expect(remoteMachineSetupCommand({ ...form, key: "x'; touch /tmp/oops; '" })).toContain("--key 'x'\"'\"'; touch /tmp/oops; '\"'\"''");
  expect(remoteMachineSetupCommand({ ...form, instance: "" })).toBeNull();
  expect(remoteMachineSetupCommand({ ...form, profile: "default\ncommand" })).toBeNull();
  expect(remoteMachineSetupCommand({ ...form, platform: "mac", serviceUser: "codecast" })).toContain("--service-user 'codecast'");
});

test("new Mac requires a dedicated host and includes the selected account", () => {
  expect(remoteMachineSetupCommand({ ...form, mode: "new", platform: "mac" })).toBeNull();
  const command = remoteMachineSetupCommand({ ...form, mode: "new", platform: "mac", dedicatedHost: "h-1234", profile: "team" });
  expect(command).toContain("cast hosts create mac");
  expect(command).toContain("--dedicated-host 'h-1234'");
  expect(command).toContain("--profile 'team'");
});

describe("a saved image", () => {
  const base = { platform: "linux" as const, mode: "new" as const, instance: "", region: "us-west-2", profile: "", key: "~/.ssh/k.pem", name: "dev", image: "", keyName: "k", subnet: "subnet-1", securityGroup: "sg-1", dedicatedHost: "" };
  test("makes the image optional and leaves --image off so create starts from the newest", () => {
    expect(remoteMachineSetupCommand(base)).toBeNull();
    const cmd = remoteMachineSetupCommand({ ...base, savedImage: "ami-0abc" })!;
    expect(cmd).not.toContain("--image");
    expect(remoteMachineSetupCommand({ ...base, savedImage: "ami-0abc", image: "ami-0def" })).toContain("--image 'ami-0def'");
  });
});

test("a new Mac needs no image: it starts from codecast's base image", () => {
  const command = remoteMachineSetupCommand({ platform: "mac", mode: "new", instance: "", region: "us-east-2", profile: "", key: "~/.ssh/k.pem", name: "mac1", image: "", keyName: "k", subnet: "subnet-1", securityGroup: "sg-1", dedicatedHost: "h-1" });
  expect(command).toContain("cast hosts create mac");
  expect(command).not.toContain("--image");
});
