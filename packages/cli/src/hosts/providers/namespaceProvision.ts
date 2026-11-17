import { remoteExec } from "../../browser/remote.js";
import { RUN_LIMIT_FILES } from "../../cloud/hostReadiness.js";
import {
  hostCastVersions, idleConfigScript, idleInstallScript, provisionHostCast, remoteDaemonEnv, remoteDeviceMarkerCommand, runScript,
  type ProvisionReport, type provisionLinuxHost,
} from "../../browser/provisionLinux.js";
import { shq, type RemoteHost } from "../../remote/session-move.js";
import { devbox, READ_TIMEOUT_MS } from "./namespace.js";

export const DAEMON_SERVICE = "codecast-daemon";
export const IDLE_SERVICE = "cast-idle";

const CAST = "/usr/local/bin/cast";
const PACKAGES = "tmux git rsync curl jq sshfs unzip python3 iproute2 procps";

const DAEMON_ALIVE = `p=$(cat "$HOME/.codecast/daemon.pid" 2>/dev/null); [ -n "$p" ] && tr '\\0' ' ' 2>/dev/null < /proc/$p/cmdline | grep -q _daemon`;

export function namespaceBaseScript(o: { idleStopMinutes: number; maxRunMinutes?: number; home: string }): string {
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[1/3] packages"
NEED=""
for p in ${PACKAGES}; do dpkg -s "$p" >/dev/null 2>&1 || NEED="$NEED $p"; done
if [ -n "$NEED" ]; then sudo apt-get update -qq && sudo apt-get install -y -qq $NEED; fi

echo "[2/3] idle watchdog (${o.idleStopMinutes}m, task marker)"
${idleConfigScript(o.idleStopMinutes, { action: "marker", home: o.home })}
${idleInstallScript()}

echo "[3/3] run limit"
${o.maxRunMinutes ? `echo "${o.maxRunMinutes}" | sudo tee ${RUN_LIMIT_FILES.max} >/dev/null` : `sudo rm -f ${RUN_LIMIT_FILES.max}`}
echo PROVISION-BASE-OK`;
}

export const serviceDeleteArgs = (box: string, name: string): string[] => ["service", "delete", box, name, "--force"];

const serviceCreateArgs = (box: string, name: string, script: string): string[] => ["service", "create", box, "--name", name, "--no_logs", "--", "sh", "-c", script];

export function daemonServiceArgs(box: string, home: string): string[] {
  const env = remoteDaemonEnv(home).map(([name, value]) => `${name}=${shq(value)}`).join(" ");
  return serviceCreateArgs(box, DAEMON_SERVICE, `export ${env}; while :; do ${DAEMON_ALIVE} || ${CAST} _daemon; sleep 5; done`);
}

export function idleServiceArgs(box: string): string[] {
  return serviceCreateArgs(box, IDLE_SERVICE, "sleep 300; while :; do sudo -n /usr/local/bin/cast-idle-check; sleep 120; done");
}

type DevboxService = { name: string; status: string };

function listServices(box: string): DevboxService[] {
  const { services = [] } = JSON.parse(devbox(["service", "list", box, "-o", "json"], READ_TIMEOUT_MS)) as { services?: DevboxService[] };
  return services;
}

function deleteService(box: string, name: string): void {
  if (listServices(box).some((service) => service.name === name)) devbox(serviceDeleteArgs(box, name));
}

function waitForDaemon(host: RemoteHost): string {
  const out = remoteExec(host, `for i in $(seq 1 30); do if ${DAEMON_ALIVE}; then echo "DAEMON-PID=$p"; exit 0; fi; sleep 1; done; echo DAEMON-DOWN`, 60_000);
  const pid = out.match(/DAEMON-PID=(\d+)/)?.[1];
  if (!pid) throw new Error(`the ${DAEMON_SERVICE} service is created but no daemon came up within 30 s: devbox service list ${host.address}`);
  return pid;
}

function startDaemonService(host: RemoteHost, home: string): string {
  deleteService(host.address, DAEMON_SERVICE);
  const prep = runScript(host, `set -euo pipefail\nCODECAST_NO_AUTO_UPDATE=1 ${CAST} stop\n${remoteDeviceMarkerCommand(home)}\necho DAEMON-PREP-OK`, 60_000);
  if (!prep.includes("DAEMON-PREP-OK")) throw new Error(`daemon preparation failed:\n${prep.slice(-400)}`);
  devbox(daemonServiceArgs(host.address, home));
  return waitForDaemon(host);
}

export function restartDevboxDaemon(host: RemoteHost): { pid: string } {
  remoteExec(host, `CODECAST_NO_AUTO_UPDATE=1 ${CAST} stop`, 60_000);
  return { pid: waitForDaemon(host) };
}

function serviceStatuses(box: string): string {
  let services: DevboxService[] | undefined;
  try { services = listServices(box); } catch { services = undefined; }
  return [DAEMON_SERVICE, IDLE_SERVICE].map((name) => `${name}=${services ? services.find((s) => s.name === name)?.status ?? "missing" : "unknown"}`).join(" ");
}

export async function provisionDevboxHost(
  host: RemoteHost,
  opts: Parameters<typeof provisionLinuxHost>[1] & { maxRunMinutes?: number },
  onProgress: (m: string) => void = () => {},
  castStep: typeof provisionHostCast = provisionHostCast,
): Promise<ProvisionReport> {
  const home = host.homeDir ?? `/home/${host.user}`;
  onProgress("base stack: packages, idle watchdog, run limit (no display stack on Namespace)…");
  const base = runScript(host, namespaceBaseScript({ idleStopMinutes: opts.idleStopMinutes, maxRunMinutes: opts.maxRunMinutes, home }), 600_000);
  if (!base.includes("PROVISION-BASE-OK")) throw new Error(`base provisioning did not complete:\n${base.slice(-800)}`);
  opts.onBaseInstalled?.();
  onProgress("starting the idle watchdog service…");
  deleteService(host.address, IDLE_SERVICE);
  devbox(idleServiceArgs(host.address));

  const common = await castStep(host, opts, onProgress);

  let device = "daemon skipped";
  if (!opts.skipDaemon) {
    onProgress("starting the daemon service…");
    device = `running (pid ${startDaemonService(host, home)})`;
  }

  return {
    chrome: "none (no display on Namespace hosts: no host browser)",
    ...hostCastVersions(host),
    services: serviceStatuses(host.address),
    device,
    ...common,
  };
}
