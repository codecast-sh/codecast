import { expect, test } from "bun:test";
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
