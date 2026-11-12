// Touch ID inside the app (convex/deviceKeys.ts, vault.md "Touch ID"). Electron
// runs no platform passkeys, so instead of opening /confirm in a browser the
// app holds its own key in the Secure Enclave (native/deviceKey.swift) and
// signs a presence challenge after the system Touch ID prompt.
//
// The page names only the challenge's random value and the prompt's words;
// this side builds the exact bytes (the same as
// shared/contracts/secrets.deviceKeyMessage), so the key signs nothing but a
// codecast challenge. A new key stays in memory until the server took it
// (`keep`), so a refused setup never replaces a key that works.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const PURPOSES = new Set(["register", "presence"]);
const CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_REASON = 200;

const message = (purpose, challenge) => `codecast-device-key/v1\n${purpose}\n${challenge}`;
const credentialId = (publicKey) => createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");

function loadAddon() {
  if (process.platform !== "darwin") return null;
  try {
    return require("./native/deviceKey.node");
  } catch {
    return null;
  }
}

/**
 * `file` holds { blob, public_key } for the key this Mac has set up. `addon`
 * is the native module (tests pass a fake). Every method answers a plain
 * object: an `error`, `cancelled` when the person dismissed the prompt, or the
 * result.
 */
function createDeviceKey({ file, addon = loadAddon() }) {
  const pending = new Map();
  const read = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      return saved && typeof saved.blob === "string" && typeof saved.public_key === "string" ? saved : null;
    } catch {
      return null;
    }
  };
  const checked = (args) => {
    const purpose = String(args?.purpose ?? "");
    const challenge = String(args?.challenge ?? "");
    if (!PURPOSES.has(purpose) || !CHALLENGE.test(challenge)) return null;
    return { purpose, challenge, reason: String(args?.reason ?? "confirm in Codecast").slice(0, MAX_REASON) };
  };
  const run = async (call) => {
    try {
      return JSON.parse(await call());
    } catch (e) {
      return { error: e?.message || "Touch ID did not finish" };
    }
  };

  return {
    /** Whether this Mac can hold a key, the credential id of the one it holds, and this Mac's name. */
    status() {
      const saved = read();
      return { available: !!addon?.available(), credential_id: saved ? credentialId(saved.public_key) : null, name: os.hostname().replace(/\.local$/, "") };
    },
    /** Make a new key and sign the register challenge with it (the person's Touch ID): { public_key, signature, credential_id }. */
    async create(args) {
      const a = checked({ ...args, purpose: "register" });
      if (!a) return { error: "Nothing to set up" };
      if (!addon?.available()) return { error: "This Mac has no Secure Enclave" };
      const made = await run(() => addon.create(message("register", a.challenge), a.reason));
      if (made.error || made.cancelled) return made;
      const id = credentialId(made.public_key);
      pending.set(id, { blob: made.blob, public_key: made.public_key });
      return { public_key: made.public_key, signature: made.signature, credential_id: id };
    },
    /** The server stored the key `create` made: this Mac keeps it from now on. */
    keep(id) {
      const key = pending.get(String(id));
      if (!key) return { error: "No new key to keep" };
      pending.clear();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(key), { mode: 0o600 });
      return { kept: true };
    },
    /** Sign a presence challenge with this Mac's key, once the person answers Touch ID: { signature, credential_id }. */
    async sign(args) {
      const a = checked({ ...args, purpose: "presence" });
      if (!a) return { error: "Nothing to confirm" };
      const saved = read();
      if (!saved || !addon) return { error: "Touch ID is not set up in this app" };
      const signed = await run(() => addon.sign(saved.blob, message("presence", a.challenge), a.reason));
      return signed.error || signed.cancelled ? signed : { signature: signed.signature, credential_id: credentialId(saved.public_key) };
    },
  };
}

module.exports = { createDeviceKey, deviceKeyMessage: message };
