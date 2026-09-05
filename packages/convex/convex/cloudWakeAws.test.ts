import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  buildStartInstancesRequest, CloudWakeAwsError, findCloudWakeHost, parseCloudWakeAllowlist, startCloudInstance,
  type AwsWakeCredentials, type CloudWakeHost,
} from "./cloudWakeAws";

const host: CloudWakeHost = {
  ownerUserId: "owner-1", deviceId: "cloud-linux-1", instanceId: "i-1234567890abcdef0", region: "us-east-1",
};
const credentials: AwsWakeCredentials = {
  accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2026-09-05T12:34:56.789Z");
const requestId = "59dbff89-35bd-4eac-99ed-be587EXAMPLE";
const normalBody = `Action=StartInstances&Version=2016-11-15&InstanceId.1=${host.instanceId}`;
const temporaryToken = "temporary/session+token==";
const exampleSignature = "8fe3e4f54d75505e36607343ba897ea6fcb711902342bbdf684fba6daf3e6f9c";
const exampleTokenSignature = "9aefc44f9b2e70dd516d7187ed5841158496698906dac5aff25209a41163d06b";

function successXml(instanceId = host.instanceId, name = "pending", code = "0") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<StartInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>${requestId}</requestId>
  <instancesSet><item><instanceId>${instanceId}</instanceId>
    <currentState><code>${code}</code><name>${name}</name></currentState>
    <previousState><code>80</code><name>stopped</name></previousState>
  </item></instancesSet>
</StartInstancesResponse>`;
}

function errorXml(code: string, message = "AWS diagnostic must stay private") {
  return `<Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors><RequestID>${requestId}</RequestID></Response>`;
}

function fetchResponse(xml: string, status = 200) {
  return mock(async () => new Response(xml, { status, headers: { "content-type": "text/xml" } }));
}

function startWith(xml: string, status = 200, dryRun = false) {
  return startCloudInstance(host, credentials, { now, dryRun, fetchImpl: fetchResponse(xml, status) as unknown as typeof fetch });
}

async function expectSanitizedFailure(promise: Promise<unknown>, code: string, status?: number) {
  const failure: unknown = await promise.then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(CloudWakeAwsError);
  expect(failure).toMatchObject({ code, status, message: status === undefined ? code : `${code} (HTTP ${status})` });
  expect(failure).not.toHaveProperty("cause");
}

afterEach(() => mock.restore());

describe("cloud wake allowlist", () => {
  test.each([undefined, "", " \n\t", "[]"])("missing/empty configuration %j disables waking", (raw) => {
    expect(parseCloudWakeAllowlist(raw)).toEqual([]);
  });

  test("accepts both instance ID lengths and exact owner/device matches", () => {
    const other = { ...host, ownerUserId: "owner-2", instanceId: "i-01234567" };
    const hosts = parseCloudWakeAllowlist(JSON.stringify([host, other]));
    expect(hosts).toEqual([host, other]);
    expect(findCloudWakeHost(hosts, host.ownerUserId, host.deviceId)).toBe(hosts[0]);
    expect(findCloudWakeHost(hosts, other.ownerUserId, other.deviceId)).toBe(hosts[1]);
    for (const [owner, device] of [["owner-3", host.deviceId], [host.ownerUserId, "other-device"],
      ["OWNER-1", host.deviceId], [host.ownerUserId, "cloud-linux"], [host.ownerUserId, ""], ["", host.deviceId]]) {
      expect(findCloudWakeHost(hosts, owner, device)).toBeUndefined();
    }
    expect(findCloudWakeHost([], host.ownerUserId, host.deviceId)).toBeUndefined();
  });

  test.each(["not JSON secret", "null", "{}", '"secret"', "[null]", "[[]]", "[1]", '[{}]', '[true]', '[{"secret":"hidden"}]'])
  ("rejects malformed configuration without echoing it: %s", (raw) => {
    expect(() => parseCloudWakeAllowlist(raw)).toThrow(new CloudWakeAwsError("InvalidAllowlist"));
  });

  test("requires precisely the four host keys and their string types", () => {
    for (const key of Object.keys(host)) {
      const missing = { ...host } as Record<string, unknown>;
      delete missing[key];
      for (const row of [missing, { ...host, [key]: null }, { ...host, [key]: 123 }, { ...host, [key]: [host.ownerUserId] }]) {
        expect(() => parseCloudWakeAllowlist(JSON.stringify([row]))).toThrow("InvalidAllowlist");
      }
    }
    expect(() => parseCloudWakeAllowlist(JSON.stringify([{ ...host, endpoint: "https://evil.example" }]))).toThrow("InvalidAllowlist");
  });

  test("rejects blanks, whitespace and control characters in every field", () => {
    for (const key of Object.keys(host) as (keyof CloudWakeHost)[]) {
      for (const value of ["", " ", ` ${host[key]}`, `${host[key]}\n`, `${host[key]}\r\n`, `${host[key]}\t`,
        `${host[key]}\u0000`, `${host[key]}\u007f`, `${host[key]}\u0085`, `${host[key]}\u2028`, `bad ${host[key]}`]) {
        expect(() => parseCloudWakeAllowlist(JSON.stringify([{ ...host, [key]: value }]))).toThrow("InvalidAllowlist");
      }
    }
  });

  test.each(["../owner", "owner/device", "owner@domain", "owner?token=secret", "a".repeat(129)])("rejects unsafe opaque ID %s", (id) => {
    for (const key of ["ownerUserId", "deviceId"]) {
      expect(() => parseCloudWakeAllowlist(JSON.stringify([{ ...host, [key]: id }]))).toThrow("InvalidAllowlist");
    }
  });

  test.each(["i-1234567", "i-123456789", "i-1234567890abcdef", "i-1234567890abcdef00", "i-ABCDEF12", "i-1234567g", "arn:aws:ec2:x", "i-12345678&InstanceId.2=i-87654321"])
  ("rejects malformed instance ID %s", (instanceId) => {
    expect(() => parseCloudWakeAllowlist(JSON.stringify([{ ...host, instanceId }]))).toThrow("InvalidAllowlist");
  });

  test.each(["us-east-1", "ap-southeast-5", "eu-central-2", "af-south-1", "il-central-1", "mx-central-1", "me-south-1", "ca-west-1", "sa-east-1"])
  ("accepts commercial region syntax %s", (region) => {
    expect(parseCloudWakeAllowlist(JSON.stringify([{ ...host, region }]))[0].region).toBe(region);
  });

  test.each(["us-gov-west-1", "cn-north-1", "us-iso-east-1", "us-isob-east-1", "us-east-0", "us-east-01", "us-east-1a", "US-EAST-1",
    "us-east-1.amazonaws.com.evil.example", "us-east-1/evil", "us-east-1?token=x", "us-east-1#evil", "us-east-1@evil.example",
    "https://127.0.0.1", "169.254.169.254", "us-east-1:443", "us-east-1\n", "us-east-1%00", "us-east-1\\evil"])
  ("rejects noncommercial/SSRF region at parse and signing boundaries: %s", async (region) => {
    expect(() => parseCloudWakeAllowlist(JSON.stringify([{ ...host, region }]))).toThrow("InvalidAllowlist");
    await expect(buildStartInstancesRequest({ ...host, region }, credentials, { now })).rejects.toMatchObject({ code: "InvalidHost" });
  });

  test("caps the array at 32 and rejects duplicate owner/device and cross-owner instances", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ ...host, deviceId: `device-${i}`, instanceId: `i-${i.toString(16).padStart(8, "0")}` }));
    expect(parseCloudWakeAllowlist(JSON.stringify(rows))).toHaveLength(32);
    expect(() => parseCloudWakeAllowlist(JSON.stringify([...rows, { ...host, deviceId: "device-33" }]))).toThrow("InvalidAllowlist");
    for (const duplicate of [host, { ...host, instanceId: "i-01234567" }, { ...host, ownerUserId: "owner-2" },
      { ...host, ownerUserId: "owner-2", deviceId: "other", region: "eu-west-2" }]) {
      expect(() => parseCloudWakeAllowlist(JSON.stringify([host, duplicate]))).toThrow("InvalidAllowlist");
    }
    expect(parseCloudWakeAllowlist(JSON.stringify([host, { ...host, deviceId: "alias" }]))).toHaveLength(2);
  });
});

describe("StartInstances SigV4 signing", () => {
  test("matches AWS CLI 2.36.28 botocore SigV4Auth offline reference, frozen UTC", async () => {
    const request = await buildStartInstancesRequest(host, credentials, { now });
    expect(request).toEqual({
      url: "https://ec2.us-east-1.amazonaws.com/", method: "POST", body: normalBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8", host: "ec2.us-east-1.amazonaws.com", "x-amz-date": "20260905T123456Z",
        authorization: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260905/us-east-1/ec2/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${exampleSignature}`,
      },
    });
    expect(await buildStartInstancesRequest(host, credentials, { now: new Date("2026-09-05T08:34:56-04:00"), dryRun: false })).toEqual(request);
    expect(new URL(request.url).search).toBe("");
  });

  test("matches independent botocore reference with a temporary token and dry run", async () => {
    const request = await buildStartInstancesRequest({ ...host, region: "eu-west-2" }, { ...credentials, sessionToken: temporaryToken }, { now, dryRun: true });
    expect(request.url).toBe("https://ec2.eu-west-2.amazonaws.com/");
    expect(request.body).toBe(`${normalBody}&DryRun=true`);
    expect(request.headers["x-amz-security-token"]).toBe(temporaryToken);
    expect(request.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260905/eu-west-2/ec2/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=${exampleTokenSignature}`);
    expect(request.body).not.toContain(temporaryToken);
  });

  test("captures the validated target and credentials before asynchronous signing", async () => {
    const mutableHost = { ...host };
    const mutableCredentials = { ...credentials };
    const request = buildStartInstancesRequest(mutableHost, mutableCredentials, { now });
    mutableHost.region = "evil.example";
    mutableHost.instanceId = "i-87654321";
    mutableCredentials.secretAccessKey = "changed";
    expect(await request).toEqual(await buildStartInstancesRequest(host, credentials, { now }));
  });

  test("validates credentials without leaking secret values or header injection", async () => {
    for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
      for (const value of ["", " ", "secret\r\nx-evil: value", "secret\n", "secret\u0000", "secret\u007f", "secret,Signature=evil", 123, null]) {
        await expect(buildStartInstancesRequest(host, { ...credentials, [key]: value } as AwsWakeCredentials, { now }))
          .rejects.toMatchObject({ message: "InvalidCredentials", code: "InvalidCredentials" });
      }
    }
  });

  test("validates instance IDs even when callers bypass allowlist parsing", async () => {
    await expect(buildStartInstancesRequest({ ...host, instanceId: "i-12345678&Action=TerminateInstances" }, credentials, { now }))
      .rejects.toMatchObject({ code: "InvalidHost" });
  });

  test("rejects invalid dates/options and sanitizes WebCrypto errors", async () => {
    await expect(buildStartInstancesRequest(host, credentials, { now: new Date(NaN) })).rejects.toMatchObject({ code: "InvalidRequest" });
    await expect(buildStartInstancesRequest(host, credentials, { dryRun: "true" as unknown as boolean })).rejects.toMatchObject({ code: "InvalidRequest" });
    spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error(credentials.secretAccessKey));
    await expect(buildStartInstancesRequest(host, credentials, { now })).rejects.toMatchObject({ message: "SigningFailed", code: "SigningFailed" });
  });
});

describe("StartInstances fetch and XML validation", () => {
  test("sends exactly one signed POST with a 20-second timeout and redirects disabled", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    const fetchImpl = fetchResponse(successXml());
    expect(await startCloudInstance(host, credentials, { now, fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ status: "starting", requestId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchImpl).toHaveBeenCalledWith("https://ec2.us-east-1.amazonaws.com/", {
      method: "POST", body: normalBody, headers: (await buildStartInstancesRequest(host, credentials, { now })).headers,
      redirect: "manual", signal: expect.any(AbortSignal),
    });
  });

  test.each([["pending", "0"], ["running", "16"], ["pending", "256"], ["running", "272"]])("accepts matching currentState %s/%s", async (name, code) => {
    expect(await startWith(successXml(host.instanceId, name, code))).toEqual({ status: "starting", requestId });
  });

  test("accepts missing request IDs and validates against the original target", async () => {
    expect(await startWith(successXml().replace(`<requestId>${requestId}</requestId>`, ""))).toEqual({ status: "starting" });
    const mutableHost = { ...host };
    const pending = startCloudInstance(mutableHost, credentials, { now, fetchImpl: fetchResponse(successXml()) as unknown as typeof fetch });
    mutableHost.instanceId = "i-87654321";
    expect(await pending).toEqual({ status: "starting", requestId });
  });

  test("accepts DryRunOperation only for explicit dryRun and HTTP 412", async () => {
    expect(await startWith(errorXml("DryRunOperation"), 412, true)).toEqual({ status: "dry_run_allowed", requestId });
    await expect(startWith(errorXml("DryRunOperation"), 412)).rejects.toMatchObject({ code: "DryRunOperation", status: 412 });
    await expect(startWith(errorXml("DryRunOperation"), 200, true)).rejects.toMatchObject({ code: "InvalidResponse", status: 200 });
    await expect(startWith(errorXml("DryRunOperation"), 503, true)).rejects.toMatchObject({ code: "DryRunOperation", status: 503 });
    await expect(startWith(successXml(), 200, true)).rejects.toMatchObject({ code: "InvalidResponse", status: 200 });
  });

  test.each([["UnauthorizedOperation", 403], ["AuthFailure", 401], ["SignatureDoesNotMatch", 403], ["InvalidInstanceID.NotFound", 400],
    ["IncorrectInstanceState", 400], ["RequestLimitExceeded", 503], ["Throttling", 429], ["InsufficientInstanceCapacity", 500], ["InternalError", 500], ["ServiceUnavailable", 503]])
  ("preserves AWS retry classification %s/%i without echoing diagnostics", async (code, status) => {
    const message = `${credentials.secretAccessKey} ${temporaryToken} Signature=${exampleSignature}`;
    await expectSanitizedFailure(startWith(errorXml(code as string, message), status as number, true), code as string, status as number);
  });

  test("unknown codes cannot smuggle sensitive strings into errors", async () => {
    await expect(startWith(errorXml(credentials.accessKeyId), 403)).rejects.toMatchObject({ code: "AwsError", message: "AwsError (HTTP 403)", status: 403 });
    await expect(startWith(errorXml(`secret:${temporaryToken}`), 503)).rejects.toMatchObject({ code: "InvalidResponse", status: 503 });
  });

  test.each([
    ["generic XML", "<Response><return>true</return></Response>"], ["plain success", "success"], ["JSON", '{"success":true}'],
    ["wrong instance", successXml("i-87654321")], ["stopped", successXml(host.instanceId, "stopped", "80")],
    ["mismatched code", successXml(host.instanceId, "running", "0")], ["code overflow", successXml(host.instanceId, "pending", "65536")],
    ["negative code", successXml(host.instanceId, "pending", "-256")], ["noninteger code", successXml(host.instanceId, "pending", "0.0")],
    ["wrong action", successXml().replaceAll("StartInstancesResponse", "StopInstancesResponse")],
    ["wrong namespace", successXml().replace("http://ec2.amazonaws.com/doc/2016-11-15/", "http://evil.example/")],
    ["truncated", successXml().replace("</StartInstancesResponse>", "")], ["unmatched trailing bracket", `${successXml()}<`],
    ["trailing junk", `${successXml()}secret`], ["multiple roots", `${successXml()}<extra/>`],
    ["mismatched XML declaration quotes", successXml().replace('version="1.0"', `version="1.0'`)],
    ["mismatched tags", successXml().replace("</currentState>", "</previousState>")],
    ["duplicate currentState", successXml().replace("</currentState>", "</currentState><currentState><code>0</code><name>pending</name></currentState>")],
    ["missing currentState", successXml().replace(/<currentState>.*?<\/currentState>/s, "")],
    ["duplicate instance ID", successXml().replace("</instanceId>", `</instanceId><instanceId>${host.instanceId}</instanceId>`)],
    ["extra instance", successXml().replace("</instancesSet>", `<item><instanceId>i-87654321</instanceId></item></instancesSet>`)],
    ["duplicate request ID", successXml().replace("</requestId>", "</requestId><requestId>other</requestId>")],
    ["invalid request ID", successXml().replace(requestId, "secret/token")],
    ["doctype/entity", `<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>${successXml()}`],
    ["comment spoof", `<Response><!-- ${successXml()} --></Response>`],
    ["CDATA spoof", `<Response><![CDATA[${successXml()}]]></Response>`],
    ["error disguised as success", errorXml("UnauthorizedOperation")], ["oversized", `${successXml()}${" ".repeat(65_536)}`],
  ])("rejects malformed or misleading 200 response: %s", async (_name, xml) => {
    await expect(startWith(xml)).rejects.toMatchObject({ code: "InvalidResponse", status: 200 });
  });

  test.each([
    ["non-XML", "temporarily unavailable"], ["wrong error root", "<Error><Code>DryRunOperation</Code></Error>"],
    ["missing code", "<Response><Errors><Error><Message>DryRunOperation</Message></Error></Errors></Response>"],
    ["duplicate code", errorXml("DryRunOperation").replace("</Code>", "</Code><Code>UnauthorizedOperation</Code>")],
    ["nested code", errorXml("<Code>DryRunOperation</Code>")],
    ["extra error", errorXml("DryRunOperation").replace("</Errors>", "<Error><Code>UnauthorizedOperation</Code></Error></Errors>")],
    ["bad entity", errorXml("DryRunOperation", "secret &unknown;")],
    ["zero entity", errorXml("DryRunOperation", "secret &#0;")],
    ["surrogate entity", errorXml("DryRunOperation", "secret &#xD800;")],
    ["overflow entity", errorXml("DryRunOperation", "secret &#x110000;")],
  ])("rejects malformed error XML: %s", async (_name, xml) => {
    await expect(startWith(xml, 412, true)).rejects.toMatchObject({ code: "InvalidResponse", status: 412 });
  });

  test("rejects unexpected status and redirects without retrying or reading their body", async () => {
    await expect(startWith(successXml(), 202)).rejects.toMatchObject({ code: "InvalidResponse", status: 202 });
    const redirected = new Response(credentials.secretAccessKey, { status: 302, headers: { location: "https://evil.example/" } });
    const read = spyOn(redirected, "text");
    const fetchImpl = mock(async () => redirected);
    await expect(startCloudInstance(host, credentials, { now, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ code: "RedirectRejected", status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  test("sanitizes network and body-read failures", async () => {
    const fetchImpl = mock(async () => { throw new Error(`network leak ${credentials.secretAccessKey}`); });
    await expectSanitizedFailure(startCloudInstance(host, credentials, { now, fetchImpl: fetchImpl as unknown as typeof fetch }), "NetworkError");
    const response = new Response("unused", { status: 503 });
    spyOn(response, "text").mockRejectedValueOnce(new Error(temporaryToken));
    await expect(startCloudInstance(host, credentials, { now, fetchImpl: mock(async () => response) as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: "NetworkError", message: "NetworkError (HTTP 503)", status: 503 });
  });

  test("classifies timeout during fetch and body reads without retaining the thrown error", async () => {
    spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const fetchImpl = mock(async (_url: unknown, init?: RequestInit) => { init?.signal?.throwIfAborted(); return new Response(); });
    await expectSanitizedFailure(startCloudInstance(host, credentials, { now, fetchImpl: fetchImpl as unknown as typeof fetch }), "RequestTimeout");
    const response = new Response("unused");
    spyOn(response, "text").mockRejectedValueOnce(new Error(temporaryToken));
    await expect(startCloudInstance(host, credentials, { now, fetchImpl: mock(async () => response) as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: "RequestTimeout", status: 200 });
  });

  test("an in-flight fetch is cancelled when the timeout signal fires", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(1));
    const fetchImpl = mock((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(temporaryToken)), { once: true });
    }));
    await expectSanitizedFailure(startCloudInstance(host, credentials, { now, fetchImpl: fetchImpl as unknown as typeof fetch }), "RequestTimeout");
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
