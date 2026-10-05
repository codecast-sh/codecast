import { describe, expect, test } from "bun:test";
import { parseSignatureHeader, signWebhook, verifyWebhook } from "./webhook";

const SECRET = "whsec_test_secret";
const T = 1_700_000_000;
const PAYLOAD = '{"id":"evt_1","type":"invoice.paid","created":1700000000,"data":{"object":{"id":"in_1"}}}';
// openssl dgst -sha256 -hmac whsec_test_secret over "1700000000.<payload>":
// an answer computed outside this code, so a wrong signed string cannot pass.
const KNOWN = "6399a56361ce17e67c2d1646a54f8d452d008f9bfc8fc1dc9d95b62989a140de";
const AT = T * 1000;

describe("verifyWebhook", () => {
  test("a valid signature verifies and returns the event", async () => {
    const result = await verifyWebhook(PAYLOAD, `t=${T},v1=${KNOWN}`, SECRET, { now: AT });
    expect(result.ok).toBe(true);
    expect(result.ok && result.event.id).toBe("evt_1");
    expect(result.ok && result.event.data.object.id).toBe("in_1");
  });

  test("signWebhook writes the header Stripe would", async () => {
    expect(await signWebhook(PAYLOAD, SECRET, T)).toBe(`t=${T},v1=${KNOWN}`);
  });

  test("a tampered body fails", async () => {
    const tampered = PAYLOAD.replace("in_1", "in_2");
    expect(await verifyWebhook(tampered, `t=${T},v1=${KNOWN}`, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a moved timestamp fails, since the timestamp is signed", async () => {
    expect(await verifyWebhook(PAYLOAD, `t=${T + 1},v1=${KNOWN}`, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("the wrong secret fails", async () => {
    expect(await verifyWebhook(PAYLOAD, `t=${T},v1=${KNOWN}`, "whsec_other", { now: AT })).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("a stale delivery fails even when signed", async () => {
    const header = await signWebhook(PAYLOAD, SECRET, T);
    expect(await verifyWebhook(PAYLOAD, header, SECRET, { now: AT + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyWebhook(PAYLOAD, header, SECRET, { now: AT - 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect((await verifyWebhook(PAYLOAD, header, SECRET, { now: AT + 299_000 })).ok).toBe(true);
    expect((await verifyWebhook(PAYLOAD, header, SECRET, { now: AT + 3_600_000, toleranceSec: 7200 })).ok).toBe(true);
  });

  test("any matching v1 passes, so a rotating secret keeps working", async () => {
    const header = `t=${T},v1=${"0".repeat(64)},v0=abc,v1=${KNOWN}`;
    expect((await verifyWebhook(PAYLOAD, header, SECRET, { now: AT })).ok).toBe(true);
  });

  test("fails closed without a secret, a header, a timestamp or a signature", async () => {
    expect(await verifyWebhook(PAYLOAD, `t=${T},v1=${KNOWN}`, undefined, { now: AT })).toEqual({ ok: false, reason: "no_secret" });
    expect(await verifyWebhook(PAYLOAD, null, SECRET, { now: AT })).toEqual({ ok: false, reason: "no_header" });
    expect(await verifyWebhook(PAYLOAD, `v1=${KNOWN}`, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_header" });
    expect(await verifyWebhook(PAYLOAD, `t=${T},v0=${KNOWN}`, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_header" });
  });

  test("a signed body that is not an event is refused", async () => {
    const header = await signWebhook("not json", SECRET, T);
    expect(await verifyWebhook("not json", header, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_payload" });
    const empty = await signWebhook("{}", SECRET, T);
    expect(await verifyWebhook("{}", empty, SECRET, { now: AT })).toEqual({ ok: false, reason: "bad_payload" });
  });

  test("parseSignatureHeader reads spaces and uppercase hex", () => {
    expect(parseSignatureHeader(" t=5 , v1=ABC ")).toEqual({ timestamp: 5, signatures: ["abc"] });
  });
});
