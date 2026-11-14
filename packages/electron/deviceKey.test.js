// Run: node --test packages/electron/deviceKey.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, sign, verify, createHash } = require("node:crypto");
const { createDeviceKey } = require("./deviceKey");

const CHALLENGE = "Q2hhbGxlbmdlVmFsdWVGb3JUZXN0aW5nMTIzNDU2";

/** A software stand-in for the Secure Enclave: the blob is the private key, every call is recorded. */
function fakeAddon({ answer } = {}) {
  const calls = [];
  const raw = (pub) => pub.export({ format: "jwk" });
  const point = (pub) => {
    const jwk = raw(pub);
    return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  };
  const signWith = (pem, msg) => sign("sha256", Buffer.from(msg), { key: pem, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return {
    calls,
    available: () => true,
    async create(msg, reason) {
      calls.push({ op: "create", msg, reason });
      if (answer) return JSON.stringify(answer);
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const pem = privateKey.export({ format: "pem", type: "pkcs8" });
      return JSON.stringify({ blob: Buffer.from(pem).toString("base64url"), public_key: point(publicKey), signature: signWith(pem, msg) });
    },
    async sign(blob, msg, reason) {
      calls.push({ op: "sign", blob, msg, reason });
      if (answer) return JSON.stringify(answer);
      return JSON.stringify({ signature: signWith(Buffer.from(blob, "base64url").toString(), msg) });
    },
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "devkey-")), "device-key.json");
const pubKeyOf = (b64) => {
  const p = Buffer.from(b64, "base64url");
  return { key: { kty: "EC", crv: "P-256", x: p.subarray(1, 33).toString("base64url"), y: p.subarray(33).toString("base64url") }, format: "jwk" };
};

test("create signs the register message, keeps nothing until the server took it, then signs presence with the kept key", async () => {
  const addon = fakeAddon();
  const file = tmpFile();
  const dk = createDeviceKey({ file, addon });
  assert.equal(dk.status().available, true);
  assert.equal(dk.status().credential_id, null);
  assert.ok(dk.status().name);

  const made = await dk.create({ challenge: CHALLENGE, reason: "set up Touch ID for Codecast" });
  assert.equal(addon.calls[0].msg, `codecast-device-key/v1\nregister\n${CHALLENGE}`);
  assert.equal(made.credential_id, createHash("sha256").update(Buffer.from(made.public_key, "base64url")).digest("base64url"));
  assert.ok(verify("sha256", Buffer.from(addon.calls[0].msg), { ...pubKeyOf(made.public_key), dsaEncoding: "ieee-p1363" }, Buffer.from(made.signature, "base64url")));
  assert.equal(dk.status().credential_id, null);
  assert.ok((await dk.sign({ challenge: CHALLENGE })).error);

  assert.deepEqual(dk.keep(made.credential_id), { kept: true });
  assert.equal(dk.status().credential_id, made.credential_id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const signed = await dk.sign({ challenge: CHALLENGE, reason: "approve convex-admin-key for jx750d6" });
  assert.equal(signed.credential_id, made.credential_id);
  assert.equal(addon.calls[1].msg, `codecast-device-key/v1\npresence\n${CHALLENGE}`);
  assert.equal(addon.calls[1].reason, "approve convex-admin-key for jx750d6");
  assert.ok(verify("sha256", Buffer.from(addon.calls[1].msg), { ...pubKeyOf(made.public_key), dsaEncoding: "ieee-p1363" }, Buffer.from(signed.signature, "base64url")));
});

test("the page cannot choose what is signed: the purpose is fixed by the call and a malformed challenge is refused", async () => {
  const addon = fakeAddon();
  const dk = createDeviceKey({ file: tmpFile(), addon });
  const made = await dk.create({ challenge: CHALLENGE, purpose: "presence" });
  dk.keep(made.credential_id);
  assert.match(addon.calls[0].msg, /\nregister\n/);
  await dk.sign({ challenge: CHALLENGE, purpose: "register" });
  assert.match(addon.calls[1].msg, /\npresence\n/);
  for (const challenge of ["", "short", `${CHALLENGE}\nextra`, "x".repeat(200)]) {
    assert.ok((await dk.sign({ challenge })).error);
  }
  assert.equal(addon.calls.length, 2);
});

test("a dismissed prompt answers cancelled and keeps nothing; a key not kept is never stored", async () => {
  const dk = createDeviceKey({ file: tmpFile(), addon: fakeAddon({ answer: { cancelled: true } }) });
  assert.deepEqual(await dk.create({ challenge: CHALLENGE }), { cancelled: true });
  assert.ok(dk.keep("anything").error);
  assert.equal(dk.status().credential_id, null);
});

test("no addon reads as unavailable, never a crash", async () => {
  const dk = createDeviceKey({ file: tmpFile(), addon: null });
  assert.equal(dk.status().available, false);
  assert.equal(dk.status().credential_id, null);
  assert.ok((await dk.create({ challenge: CHALLENGE })).error);
});
