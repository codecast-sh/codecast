// The installed-app registry (docs/architecture/installed-apps.md, "Names"):
// settings.json's `installedApps`, keyed by slug. One record per install:
//
//   {slug, name, iconPath, installedAt, grantedVersion, grants, bounds,
//    trayBounds, gate, facts}
//
// - `gate` is the page's gate keys (k, e, m, i). Each value is sealed with
//   Electron safeStorage when the OS offers it (the Keychain on macOS, DPAPI
//   on Windows); `gateOf(slug)` opens them. A value stored where sealing was
//   unavailable stays plain, and is sealed the next time the gate is written.
// - `facts` is the last appInfo answer for the slug (without its `gate`):
//   the version, relation and policy the engine decides by
//   (docs "Facts: version, relation and policy").
//
// Every write re-reads settings.json and replaces it in one rename
// (settingsFile.js), so a write never lands over a stale copy. Each change
// fires "change" with the slug.
//
// Kept free of electron so it is unit-testable: main.js passes the settings
// file and a sealer built from safeStorage (`safeStorageSealer`).
const { EventEmitter } = require("node:events");

const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const GATE_KEYS = ["k", "e", "m", "i"];
const SEALED = "sealed:";

/** Whether `slug` is a page slug safe to put in a partition name, a bundle id and an AUMID. */
const isSlug = (slug) => typeof slug === "string" && SLUG.test(slug);

/** A sealer over Electron's safeStorage; values pass through plain where the OS has no store. */
function safeStorageSealer(safeStorage) {
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    seal: (text) => (available() ? SEALED + safeStorage.encryptString(text).toString("base64") : text),
    open: (stored) => (stored.startsWith(SEALED) ? safeStorage.decryptString(Buffer.from(stored.slice(SEALED.length), "base64")) : stored),
  };
}

/** The appInfo answer as kept in a record: everything but the gate keys. */
function factsOf(info) {
  if (!info || typeof info !== "object") return null;
  const { gate: _gate, ...facts } = info;
  return facts;
}

function createRegistry({ settings, sealer, now = Date.now }) {
  const events = new EventEmitter();
  const all = () => {
    const apps = settings.load().installedApps;
    return apps && typeof apps === "object" && !Array.isArray(apps) ? apps : {};
  };
  const write = (slug, apps) => {
    settings.update({ installedApps: apps });
    events.emit("change", slug);
  };

  function sealGate(gate) {
    const out = {};
    for (const key of GATE_KEYS) {
      const value = gate && gate[key];
      if (typeof value === "string" && value) out[key] = sealer.seal(value);
    }
    return out;
  }

  const registry = {
    list: () => Object.values(all()),
    get: (slug) => all()[slug] || null,

    /** Adds (or replaces) an install. `gate` is given plain and stored sealed. */
    add({ slug, name, gate, facts, iconPath = null }) {
      if (!isSlug(slug)) throw new Error(`not a page slug: ${slug}`);
      const apps = all();
      const prev = apps[slug] || {};
      apps[slug] = {
        bounds: null,
        trayBounds: null,
        grants: [],
        grantedVersion: 0,
        ...prev,
        slug,
        name: String(name || slug),
        iconPath: iconPath || prev.iconPath || null,
        installedAt: prev.installedAt || now(),
        gate: sealGate(gate),
        facts: factsOf(facts) || prev.facts || null,
      };
      write(slug, { ...apps });
      return apps[slug];
    },

    /** Merges `patch` over the record as it is on disk now. A `gate` in the patch is sealed. */
    update(slug, patch) {
      const apps = all();
      if (!apps[slug]) {
        const err = new Error(`${slug} is not installed on this computer`);
        err.code = "not-installed";
        throw err;
      }
      const next = { ...apps[slug], ...patch };
      if (patch && "gate" in patch) next.gate = sealGate(patch.gate);
      write(slug, { ...apps, [slug]: next });
      return next;
    },

    remove(slug) {
      const apps = all();
      if (!apps[slug]) return false;
      const { [slug]: _gone, ...rest } = apps;
      write(slug, rest);
      return true;
    },

    /** The stored gate keys, opened. A key that no longer opens (a new OS keystore) is dropped. */
    gateOf(slug) {
      const record = all()[slug];
      const out = {};
      for (const [key, stored] of Object.entries((record && record.gate) || {})) {
        if (!GATE_KEYS.includes(key) || typeof stored !== "string") continue;
        try {
          out[key] = sealer.open(stored);
        } catch {}
      }
      return out;
    },

    /**
     * Stores the latest appInfo answer. Returns {changed, prevVersion} so the
     * host can tell a republish from a repeat. A repeat writes nothing.
     */
    setFacts(slug, info) {
      const apps = all();
      const record = apps[slug];
      const facts = factsOf(info);
      if (!record || !facts) return { changed: false, prevVersion: null };
      const prevVersion = record.facts ? Number(record.facts.version) || 0 : null;
      if (JSON.stringify(record.facts) === JSON.stringify(facts)) return { changed: false, prevVersion };
      write(slug, { ...apps, [slug]: { ...record, facts } });
      return { changed: true, prevVersion };
    },

    /** Subscribes to changes; returns the unsubscribe. */
    onChange(cb) {
      events.on("change", cb);
      return () => events.off("change", cb);
    },
  };
  return registry;
}

module.exports = { createRegistry, safeStorageSealer, isSlug, factsOf, GATE_KEYS };
