import { describe, expect, test } from "bun:test";
import { internalAddressRefusal, internalHostRefusal, ipv6Groups } from "./internalHost";

describe("internalAddressRefusal", () => {
  test("loopback, private, link-local, CGNAT, metadata, multicast and reserved addresses are refused, v4 and v6", () => {
    for (const ip of [
      "127.0.0.1", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.100.100.200", "192.0.0.192", "198.18.0.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fd00:ec2::254", "fc00::1", "fe80::1", "fec0::1", "ff02::1",
      "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:0a00:0001::1",
      "2001:db8::1", "2001::1", "::10.0.0.1", "nonsense",
    ]) expect([ip, internalAddressRefusal(ip) !== null]).toEqual([ip, true]);
  });

  test("public addresses pass", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2002:0808:0808::1"]) {
      expect([ip, internalAddressRefusal(ip)]).toEqual([ip, null]);
    }
  });

  test("IPv6 parses every textual form", () => {
    expect(ipv6Groups("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(ipv6Groups("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Groups("1::2::3")).toBeNull();
    expect(ipv6Groups("1:2:3")).toBeNull();
  });
});

describe("internalHostRefusal", () => {
  test("internal names, docker service names and literal private hosts are refused", () => {
    for (const url of [
      "http://localhost:3210", "http://postgres:5432", "http://convex-backend:3210/api", "http://metadata.google.internal",
      "http://printer.local", "http://nas.home.arpa", "http://169.254.169.254/latest/meta-data", "http://[fd00:ec2::254]",
      "http://2130706433", "http://0x7f.1", "file:///etc/passwd", "http://api.codecast.test",
    ]) expect([url, internalHostRefusal(url, ["codecast.test"]) !== null]).toEqual([url, true]);
  });

  test("public hosts pass over http and https", () => {
    for (const url of ["http://api.example.com/v1", "https://api.example.com", "http://8.8.8.8:8080/x", "https://[2606:4700::1111]/"]) {
      expect([url, internalHostRefusal(url)]).toEqual([url, null]);
    }
  });
});
