import { expect, test } from "bun:test";
import { optionsLike } from "./create";
import { hostActionArgs } from "../cloud/hostReports";
import type { CloudHost } from "../browser/cloudHost";

const host: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k.pem", profile: "union" };
const inst = { SubnetId: "subnet-1", SecurityGroups: [{ GroupId: "sg-1" }], KeyName: "kp" };

test("--like copies region, network, key and profile; given options win", () => {
  expect(optionsLike({}, host, inst, "linux", "abc123")).toEqual({
    name: "codecast-linux-abc123", key: "/k.pem", keyName: "kp", subnet: "subnet-1", securityGroup: "sg-1", region: "us-west-2", profile: "union",
  });
  expect(optionsLike({ subnet: "subnet-9", name: "mine" }, host, inst, "linux", "x")).toMatchObject({ subnet: "subnet-9", name: "mine" });
  expect(() => optionsLike({}, host, { SubnetId: "s" }, "linux", "x")).toThrow("no subnet, security group or key pair");
});

test("a clone launches a Linux host like the source at an offered size only", () => {
  expect(hostActionArgs("clone", "i-1", undefined, "t3.xlarge")).toEqual(["hosts", "create", "linux", "--like", "i-1", "--type", "t3.xlarge"]);
  expect(() => hostActionArgs("clone", "i-1", undefined, "p5.48xlarge")).toThrow("clone needs a host size");
});
