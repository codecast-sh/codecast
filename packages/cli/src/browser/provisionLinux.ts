/**
 * Turn a bare Ubuntu EC2 instance into a full codecast remote service.
 *
 * One idempotent command installs four capabilities:
 *
 *   1. A real display. Chrome on the box renders into Xvfb (:99) instead of
 *      running headless, so its pixels exist somewhere a camera can point at.
 *   2. A live view. mediamtx serves the display as RTSP (VLC) and HLS (any
 *      browser). The encoder only runs while someone is actually watching
 *      (runOnDemand), so the stream costs zero CPU the rest of the time.
 *      Both listeners bind to loopback ONLY — the screen shows logged-in
 *      pages, and the way in is an SSH tunnel, never an open port.
 *   3. An idle watchdog. The box powers itself off after N minutes with no
 *      inbound SSH, no Chrome, no Claude and no viewer. EC2 turns an OS
 *      shutdown into a "stopped" instance, so idle time costs only the disk.
 *   4. A codecast daemon. The bundled cast CLI runs under bun as a systemd
 *      service with CODECAST_REMOTE_DEVICE=1, registering the box as a remote
 *      device sessions can be moved to (`cast remote move`).
 *
 * The provisioning script travels over ssh stdin (the same pattern as
 * remoteSnapshotScript in wipSnapshot.ts) — nothing needs to be present on the
 * box beforehand except the Ubuntu image itself.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteHost } from "../remote/session-move.js";
import { copyCredentialToRemote, ensureRemoteClaudeReady } from "../remote/session-move.js";
import { remoteExec, scpTo } from "./remote.js";
import { decryptToken } from "../tokenEncryption.js";

/** The Xvfb display everything on the box shares. */
export const SCREEN_DISPLAY = ":99";
export const SCREEN_SIZE = { width: 1440, height: 900 };
/** Loopback ports on the box; reached from here through an SSH tunnel. */
export const RTSP_PORT = 8554;
export const HLS_PORT = 8888;
/** Machine-level VNC (x11vnc) and its browser client (noVNC via websockify). */
export const VNC_PORT = 5900;
export const NOVNC_PORT = 6080;

const MEDIAMTX_VERSION = "v1.20.1";

/**
 * Everything that can be done with root and apt, in one shot. Idempotent:
 * every step checks before it acts, so re-running after a partial failure
 * (or to pick up a config change) is the intended repair path.
 */
export function baseProvisionScript(idleStopMinutes: number): string {
  const { width, height } = SCREEN_SIZE;
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[1/6] packages"
NEED=""
for p in xvfb ffmpeg tmux git rsync curl jq; do dpkg -s "$p" >/dev/null 2>&1 || NEED="$NEED $p"; done
if [ -n "$NEED" ]; then sudo apt-get update -qq && sudo apt-get install -y -qq $NEED; fi
if ! command -v google-chrome >/dev/null 2>&1; then
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y -qq /tmp/chrome.deb && rm /tmp/chrome.deb
fi

echo "[2/6] swap"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap -q /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "[3/6] display (Xvfb ${SCREEN_DISPLAY})"
sudo tee /etc/systemd/system/cast-display.service >/dev/null <<'UNIT'
[Unit]
Description=Virtual display for the codecast remote browser
[Service]
User=ubuntu
ExecStart=/usr/bin/Xvfb ${SCREEN_DISPLAY} -screen 0 ${width}x${height}x24 -nolisten tcp
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

echo "[4/6] stream (mediamtx ${MEDIAMTX_VERSION}, loopback only)"
if [ ! -x /usr/local/bin/mediamtx ] || ! /usr/local/bin/mediamtx --version 2>/dev/null | grep -q "${MEDIAMTX_VERSION}"; then
  wget -qO /tmp/mediamtx.tar.gz "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
  tar -xzf /tmp/mediamtx.tar.gz -C /tmp mediamtx
  sudo install -m 755 /tmp/mediamtx /usr/local/bin/mediamtx
  rm -f /tmp/mediamtx.tar.gz /tmp/mediamtx
fi
sudo tee /etc/mediamtx.yml >/dev/null <<'MTX'
# The screen stream. Loopback only — reached through an SSH tunnel.
logLevel: info
api: no
metrics: no
playback: no
rtsp: yes
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:${RTSP_PORT}
rtmp: no
hls: yes
hlsAddress: 127.0.0.1:${HLS_PORT}
webrtc: no
srt: no
paths:
  screen:
    # The encoder exists only while a viewer is connected.
    runOnDemand: >
      ffmpeg -loglevel error -f x11grab -draw_mouse 1 -framerate 12
      -video_size ${width}x${height} -i ${SCREEN_DISPLAY}
      -c:v libx264 -preset ultrafast -tune zerolatency -g 24
      -pix_fmt yuv420p -b:v 2500k -maxrate 3000k -bufsize 5000k
      -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH
    runOnDemandRestart: yes
    runOnDemandCloseAfter: 10s
MTX
sudo tee /etc/systemd/system/cast-stream.service >/dev/null <<'UNIT'
[Unit]
Description=codecast screen stream (RTSP + HLS on loopback)
After=cast-display.service
[Service]
User=ubuntu
Environment=DISPLAY=${SCREEN_DISPLAY}
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx.yml
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

echo "[4b/6] vnc (x11vnc + noVNC, loopback only)"
NEEDV=""
for p in x11vnc novnc websockify; do dpkg -s "$p" >/dev/null 2>&1 || NEEDV="$NEEDV $p"; done
if [ -n "$NEEDV" ]; then sudo apt-get install -y -qq $NEEDV; fi
sudo tee /etc/systemd/system/cast-vnc.service >/dev/null <<'UNIT'
[Unit]
Description=codecast machine-level VNC (x11vnc on loopback)
After=cast-display.service
[Service]
User=ubuntu
ExecStart=/usr/bin/x11vnc -display ${SCREEN_DISPLAY} -localhost -nopw -shared -forever -noxdamage -quiet -rfbport ${VNC_PORT}
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/cast-novnc.service >/dev/null <<'UNIT'
[Unit]
Description=codecast noVNC web client (websockify on loopback)
After=cast-vnc.service
[Service]
User=ubuntu
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:${NOVNC_PORT} 127.0.0.1:${VNC_PORT}
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

echo "[5/6] idle watchdog (${idleStopMinutes}m)"
echo "${idleStopMinutes}" | sudo tee /etc/cast-idle-minutes >/dev/null
sudo tee /usr/local/bin/cast-idle-check >/dev/null <<'IDLE'
#!/bin/bash
# Power off after N idle minutes. EC2 turns an OS shutdown into a stopped
# instance, so this is what makes idle time cost only the disk.
# "Active" means someone or something is genuinely using the machine:
#   - an inbound SSH connection (a person, a CDP tunnel, a stream viewer)
#   - the encoder running (someone is literally watching the screen)
#   - the codecast daemon's activity stamp is fresh: it touches
#     ~/.codecast/host-active when a message is delivered, a transcript grows
#     or a session launches. A dormant session's claude process is alive but
#     idle, so counting processes kept the box awake and billing forever;
#     the stamp lets it sleep, and the queued work that wakes it resumes the
#     session (its worktree and transcript are on this disk).
# Until the daemon has written a stamp at all (a box provisioned before this
# rule) the old process rules apply, so an upgrade never sleeps under a live
# session. The daemon's own outbound websocket deliberately does NOT count.
MINUTES=$(cat /etc/cast-idle-minutes 2>/dev/null || echo 0)
[ "$MINUTES" -le 0 ] && exit 0
STATE=/run/cast-last-active
STAMP=/home/ubuntu/.codecast/host-active
active=0
[ "$(ss -Htn state established '( sport = :22 )' | wc -l)" -gt 0 ] && active=1
pgrep -f 'x11grab' >/dev/null 2>&1 && active=1
if [ -f "$STAMP" ]; then
  [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt 180 ] && active=1
else
  pgrep -f 'chrome' >/dev/null 2>&1 && active=1
  pgrep -x claude >/dev/null 2>&1 && active=1
fi
now=$(date +%s)
if [ "$active" = 1 ]; then echo "$now" > "$STATE"; exit 0; fi
last=$(cat "$STATE" 2>/dev/null || echo "$now")
[ -f "$STATE" ] || echo "$now" > "$STATE"
if [ $(( now - last )) -ge $(( MINUTES * 60 )) ]; then
  logger -t cast-idle "idle for $MINUTES minutes — powering off"
  systemctl poweroff
fi
IDLE
sudo chmod 755 /usr/local/bin/cast-idle-check
sudo tee /etc/systemd/system/cast-idle.service >/dev/null <<'UNIT'
[Unit]
Description=codecast idle check
[Service]
Type=oneshot
ExecStart=/usr/local/bin/cast-idle-check
UNIT
sudo tee /etc/systemd/system/cast-idle.timer >/dev/null <<'UNIT'
[Unit]
Description=codecast idle check timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT

echo "[6/6] enable services"
sudo systemctl daemon-reload
sudo systemctl enable --now cast-display.service cast-stream.service cast-vnc.service cast-novnc.service cast-idle.timer
sudo systemctl restart cast-vnc.service cast-novnc.service
echo PROVISION-BASE-OK`;
  // Interpolation note: the \${...} constants above are filled in by THIS
  // template literal. The heredocs are quoted ('UNIT', 'MTX', 'IDLE') so the
  // remote shell expands nothing — the bare $RTSP_PORT/$MTX_PATH in
  // runOnDemand survive to mediamtx, and the $(...) in the idle script survive
  // to its own runtime.
}

/** The daemon systemd unit; installed after the cast binary and config exist. */
export function daemonUnitScript(): string {
  return `set -euo pipefail
sudo tee /etc/systemd/system/codecast-daemon.service >/dev/null <<'UNIT'
[Unit]
Description=codecast daemon (remote device)
After=network-online.target
Wants=network-online.target
[Service]
User=ubuntu
Environment=CODECAST_REMOTE_DEVICE=1
Environment=HOME=/home/ubuntu
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin
WorkingDirectory=/home/ubuntu
ExecStart=/usr/local/bin/cast _daemon
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now codecast-daemon.service
sudo systemctl restart codecast-daemon.service
echo DAEMON-UNIT-OK`;
}

/**
 * Build the cast bundles the box runs.
 *
 * NOT a compiled standalone binary: bun's --compile output segfaults on Linux
 * inside the daemon path (verified on both the modern and baseline x64
 * targets — a JSC crash in the standalone runtime). The box instead gets the
 * same shape the npm package ships — the bundled dist entrypoints — run under
 * a real bun install. dist is self-contained (workspace deps inlined), so the
 * box needs bun plus these two files, nothing else; ~8MB instead of a 95MB
 * binary, which matters on a slow uplink.
 *
 * Only possible when this cast runs from a source checkout.
 */
export function buildLinuxCast(onProgress: (m: string) => void): { indexJs: string; daemonJs: string } {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../packages/cli/src/browser
  const cliRoot = path.resolve(here, "..", "..");
  const entry = path.join(cliRoot, "src", "index.ts");
  if (!fs.existsSync(entry)) {
    throw new Error(
      "cast is not running from a source checkout, so it cannot build itself for the box.\n" +
        "  Run provisioning from the dev checkout (bun src/index.ts).",
    );
  }
  onProgress("building cast bundles (dist)…");
  execFileSync("bun", ["run", "build"], {
    cwd: cliRoot,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 300_000,
  });
  return {
    indexJs: path.join(cliRoot, "dist", "index.js"),
    daemonJs: path.join(cliRoot, "dist", "daemon.js"),
  };
}

/**
 * The box's codecast identity: the same account as this machine, with the
 * auth token DECRYPTED — `enc:` tokens are bound to this machine's hardware
 * key and would be unreadable there. The file is written 0600 over ssh stdin
 * so the secret never sits in argv or a local temp file.
 */
export function pushCodecastConfig(host: RemoteHost): void {
  const cfgPath = path.join(process.env.HOME || os.homedir(), ".codecast", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const token = typeof cfg.auth_token === "string" && cfg.auth_token.startsWith("enc:")
    ? decryptToken(cfg.auth_token)
    : cfg.auth_token;
  const remoteCfg = {
    user_id: cfg.user_id,
    auth_token: token,
    convex_url: cfg.convex_url,
    web_url: cfg.web_url,
    team_id: cfg.team_id,
    sync_mode: cfg.sync_mode ?? "all",
    created_at: cfg.created_at,
    updated_at: new Date().toISOString(),
  };
  execFileSync(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "BatchMode=yes", `${host.user}@${host.address}`,
     "umask 077; mkdir -p ~/.codecast; cat > ~/.codecast/config.json"],
    { input: JSON.stringify(remoteCfg, null, 2), timeout: 30_000 },
  );
}

export interface ProvisionReport {
  chrome: string;
  cast: string;
  claude: string;
  services: string;
  device: string;
}

/**
 * The whole provisioning, end to end, against a host that ensureUp already
 * made reachable. Safe to re-run; every step is idempotent.
 */
export async function provisionLinuxHost(
  host: RemoteHost,
  opts: { idleStopMinutes: number; skipDaemon?: boolean },
  onProgress: (m: string) => void = () => {},
): Promise<ProvisionReport> {
  onProgress("base stack: packages, display, stream, idle watchdog…");
  const base = runScript(host, baseProvisionScript(opts.idleStopMinutes), 600_000);
  if (!base.includes("PROVISION-BASE-OK")) throw new Error(`base provisioning did not complete:\n${base.slice(-800)}`);

  onProgress("installing bun runtime…");
  remoteExec(
    host,
    "command -v ~/.bun/bin/bun >/dev/null 2>&1 || " +
      "(sudo apt-get install -y -qq unzip >/dev/null 2>&1; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1); " +
      "~/.bun/bin/bun --version",
    300_000,
  );

  const bundles = buildLinuxCast(onProgress);
  onProgress("uploading cast bundles…");
  scpTo(host, bundles.indexJs, "/tmp/cast-index.js");
  scpTo(host, bundles.daemonJs, "/tmp/cast-daemon.js");
  remoteExec(
    host,
    "sudo mkdir -p /usr/local/lib/codecast && " +
      "sudo install -m 644 /tmp/cast-index.js /usr/local/lib/codecast/index.js && " +
      "sudo install -m 644 /tmp/cast-daemon.js /usr/local/lib/codecast/daemon.js && " +
      "rm -f /tmp/cast-index.js /tmp/cast-daemon.js && " +
      `printf '#!/usr/bin/env bash\\nexec /home/${host.user}/.bun/bin/bun /usr/local/lib/codecast/index.js "$@"\\n' | sudo tee /usr/local/bin/cast >/dev/null && ` +
      "sudo chmod 755 /usr/local/bin/cast",
    60_000,
  );

  onProgress("installing claude…");
  remoteExec(
    host,
    "command -v claude >/dev/null 2>&1 || (curl -fsSL https://claude.ai/install.sh | bash) >/dev/null 2>&1; " +
      "sudo ln -sf /home/ubuntu/.local/bin/claude /usr/local/bin/claude 2>/dev/null; claude --version",
    300_000,
  );

  onProgress("pushing codecast identity + claude credential…");
  pushCodecastConfig(host);
  const cred = copyCredentialToRemote(host);
  if (!cred.pushed) onProgress(`  (claude credential not pushed: ${cred.reason} — sessions there will need a healthy local login)`);

  // Accept claude's bypass-permissions dialog ONCE, so a moved session's
  // resume never parks on it. The acceptance is not a config flag any more
  // (verified on 2.1.246: the documented ~/.claude.json flag was set and the
  // dialog appeared anyway; after one interactive accept it never returns) —
  // so the only reliable pre-acceptance IS an interactive one, scripted:
  // launch claude in tmux, wait for the dialog, choose "Yes, I accept", quit.
  if (cred.pushed) {
    onProgress("pre-accepting claude's bypass-permissions dialog…");
    ensureRemoteClaudeReady(host, `${host.homeDir ?? `/home/${host.user}`}/work`);
    const accept = remoteExec(
      host,
      `mkdir -p ~/work && tmux kill-session -t cast-accept 2>/dev/null; tmux new -d -s cast-accept &&
       tmux send-keys -t cast-accept 'cd ~/work && env -u CLAUDECODE claude --permission-mode bypassPermissions' Enter
       outcome=timeout
       for i in $(seq 1 30); do
         pane=$(tmux capture-pane -p -t cast-accept 2>/dev/null)
         if echo "$pane" | grep -q "bypass permissions on"; then outcome=ready; break; fi
         if echo "$pane" | grep -q "Yes, I accept"; then
           sleep 1; tmux send-keys -t cast-accept Down; sleep 1; tmux send-keys -t cast-accept Enter
         fi
         sleep 2
       done
       tmux kill-session -t cast-accept 2>/dev/null
       echo "accept=$outcome"`,
      120_000,
    );
    if (!accept.includes("accept=ready")) {
      onProgress("  (could not confirm the acceptance — the first moved session may need one manual Enter)");
    }
  }

  let device = "daemon skipped";
  if (!opts.skipDaemon) {
    onProgress("starting the daemon service…");
    const unit = runScript(host, daemonUnitScript(), 60_000);
    if (!unit.includes("DAEMON-UNIT-OK")) throw new Error(`daemon unit install failed:\n${unit.slice(-400)}`);
    device = remoteExec(host, "systemctl is-active codecast-daemon.service", 20_000);
  }

  return {
    chrome: remoteExec(host, "google-chrome --version", 20_000),
    cast: remoteExec(host, "cast --version 2>/dev/null || /usr/local/bin/cast --version", 60_000),
    claude: remoteExec(host, "claude --version", 60_000),
    services: remoteExec(
      host,
      "for s in cast-display cast-stream cast-vnc cast-novnc codecast-daemon; do printf '%s=%s ' $s $(systemctl is-active $s.service 2>/dev/null); done; printf 'idle-timer=%s' $(systemctl is-active cast-idle.timer)",
      20_000,
    ),
    device,
  };
}

/** Run a multi-line script on the box via `bash -s` over stdin. */
function runScript(host: RemoteHost, script: string, timeoutMs: number): string {
  try {
    return execFileSync(
      "ssh",
      ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
       "-o", "BatchMode=yes", `${host.user}@${host.address}`, "bash -s"],
      { input: script, encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `remote script failed: ${String(e.stderr ?? "").trim().split("\n").slice(-3).join(" | ") || e.message}` +
        (e.stdout ? `\n  last output: ${String(e.stdout).trim().split("\n").slice(-3).join(" | ")}` : ""),
    );
  }
}
