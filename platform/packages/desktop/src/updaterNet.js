// Network layer for the self-contained desktop updater (see main.js). Pure
// Node — no Electron imports — so the download behavior that matters when a
// user is staring at a stuck banner (timeouts, resume, abort) can be exercised
// by a plain-node harness against a local server instead of only ever running
// inside a packaged app during a real release.
//
// Design constraints, learned from the v1.1.84 rollout (ct-38949 follow-up):
//   • A stream with NO timeout can stall forever. The old downloader hung on a
//     dead socket, which kept the updater's in-flight flag set, which made the
//     banner's "Try again" a silent no-op. Every request here times out on
//     connect AND on read inactivity.
//   • A 94MB download over a cold CDN edge can legitimately take minutes and
//     then die at 80%. Restarting from byte 0 on every hiccup is how a flaky
//     link never finishes — retries resume with a Range request and re-hash
//     the bytes already on disk, so progress is monotone.
//   • The caller must be able to ABORT a download it no longer wants (a user
//     retry supersedes a wedged attempt). AbortSignal is honored between and
//     during attempts.

const fs = require("fs");
const crypto = require("crypto");

function protocolModule(u) {
  // https everywhere in production; http exists so tests can run a local server.
  return new URL(u).protocol === "http:" ? require("http") : require("https");
}

// GET that follows redirects and resolves with the final 200/206 response
// stream. `timeoutMs` bounds the time to response headers — a server that
// accepts the socket but never answers must not hang the updater. `signal`
// aborts even while headers are pending (http.get honors it natively) — the
// one phase a response-stream listener can't cover.
function getFollow(url, { redirects = 3, headers = {}, timeoutMs = 30_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = protocolModule(url).get(url, { headers, signal }, (res) => {
      const sc = res.statusCode;
      if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(getFollow(new URL(res.headers.location, url).toString(), { redirects: redirects - 1, headers, timeoutMs, signal }));
      } else if (sc !== 200 && sc !== 206) {
        res.resume();
        reject(new Error(`HTTP ${sc}`));
      } else {
        resolve(res);
      }
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("connection timed out")));
    req.on("error", (e) => reject(signal?.aborted ? abortError() : e));
  });
}

async function fetchText(url, opts = {}) {
  const res = await getFollow(url, opts);
  res.setEncoding("utf8");
  let body = "";
  return new Promise((resolve, reject) => {
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve(body));
    res.on("error", reject);
  });
}

// Stream an existing partial file through a fresh sha512 so a resumed download
// still produces the digest of the COMPLETE file.
function hashExisting(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const rs = fs.createReadStream(path);
    rs.on("data", (c) => hash.update(c));
    rs.on("end", () => resolve(hash));
    rs.on("error", reject);
  });
}

function abortError() {
  const e = new Error("download aborted");
  e.aborted = true;
  return e;
}

// Download `url` to `dest`, resolving with the file's sha512 (base64).
//   • onProgress(percent): integer percent of the WHOLE file, monotone across
//     resumed attempts.
//   • signal: AbortSignal — rejects promptly when aborted, mid-transfer or
//     between retries.
//   • attempts/inactivityMs/retryDelayMs: a read gap longer than inactivityMs
//     kills the attempt; failed attempts resume from the bytes on disk.
async function downloadResumable(url, dest, opts = {}) {
  const {
    onProgress = () => {},
    signal,
    attempts = 4,
    inactivityMs = 30_000,
    retryDelayMs = 1_500,
  } = opts;

  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      if (signal?.aborted) throw abortError();
    }
    try {
      return await downloadAttempt(url, dest, {
        onProgress,
        signal,
        inactivityMs,
        resume: attempt > 0,
      });
    } catch (e) {
      if (e?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("download failed");
}

async function downloadAttempt(url, dest, { onProgress, signal, inactivityMs, resume }) {
  // Resume point: whatever a prior attempt left on disk. First attempt always
  // starts clean so a stale partial from an old run can't poison the hash.
  let start = 0;
  let hash = crypto.createHash("sha512");
  if (resume && fs.existsSync(dest)) {
    try {
      start = fs.statSync(dest).size;
      if (start > 0) hash = await hashExisting(dest);
    } catch {
      start = 0;
      hash = crypto.createHash("sha512");
    }
  }

  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  let res = await getFollow(url, { headers, timeoutMs: inactivityMs, signal });
  if (signal?.aborted) {
    // Aborted while headers were in flight — a listener added to an
    // already-aborted signal never fires, so check explicitly.
    res.destroy();
    throw abortError();
  }
  if (start > 0 && res.statusCode === 200) {
    // Server ignored the Range — it's sending the whole file. Start over.
    start = 0;
    hash = crypto.createHash("sha512");
  }
  const remaining = parseInt(res.headers["content-length"] || "0", 10);
  const total = remaining ? start + remaining : 0;

  const file = fs.createWriteStream(dest, { flags: start > 0 ? "a" : "w" });
  let received = start;
  let lastPct = -1;
  let settled = false;

  return new Promise((resolve, reject) => {
    // Reject DIRECTLY, then tear the stream down. Routing rejection through
    // res.destroy(err) → 'error' is not reliably prompt on IncomingMessage
    // (measured: an abort surfaced only when the inactivity timer later fired),
    // and promptness is the whole point of abort.
    let inactivityTimer = null;
    const cleanup = () => {
      clearTimeout(inactivityTimer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.destroy();
      file.destroy();
      reject(err);
    };
    const armInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(new Error(`download stalled (no data for ${Math.round(inactivityMs / 1000)}s)`));
      }, inactivityMs);
    };
    function onAbort() { fail(abortError()); }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    armInactivity();

    res.on("data", (chunk) => {
      armInactivity();
      received += chunk.length;
      hash.update(chunk);
      if (total) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    });
    res.on("error", fail);
    file.on("error", fail);
    file.on("finish", () => {
      if (settled) return;
      // A connection the server closed early can surface as a clean 'end' —
      // byte-count truth decides, not stream ceremony.
      if (total && received < total) {
        fail(new Error(`download truncated (${received}/${total} bytes)`));
        return;
      }
      settled = true;
      cleanup();
      file.close(() => resolve(hash.digest("base64")));
    });
    res.pipe(file);
  });
}

module.exports = { getFollow, fetchText, downloadResumable };
