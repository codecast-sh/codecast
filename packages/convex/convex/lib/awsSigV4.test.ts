import { describe, expect, test } from "bun:test";
import { presignUrl } from "./awsSigV4";

describe("presignUrl", () => {
  // The worked example in the AWS docs ("Authenticating Requests: Using Query
  // Parameters"): GET examplebucket/test.txt, 24h expiry.
  test("matches the AWS documented example", async () => {
    const url = await presignUrl({
      method: "GET",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("keeps path slashes and encodes the rest", async () => {
    const url = await presignUrl({
      method: "PUT",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      path: "/codecast/media/abc 1.mp4",
      region: "auto",
      service: "s3",
      accessKeyId: "k",
      secretAccessKey: "s",
      expiresSeconds: 60,
      now: new Date("2026-09-24T00:00:00Z"),
    });
    expect(url.startsWith("https://acct.r2.cloudflarestorage.com/codecast/media/abc%201.mp4?")).toBe(true);
    expect(url).toContain("X-Amz-Credential=k%2F20260924%2Fauto%2Fs3%2Faws4_request");
  });
});
