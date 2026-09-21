import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildHostCast, cliSourceVersion } from "../browser/provisionLinux.js";
import { remoteExec, scpTo } from "../browser/remote.js";
import { remoteHome, shq, type RemoteHost } from "../remote/session-move.js";
import { MAC_HOST_PATH } from "./provisionMac.js";

export function installMacCast(host: RemoteHost, log: (message: string) => void): string {
  const build = buildHostCast(log, "darwin");
  try {
    const archive = path.join(build.distDir, "../", `${path.basename(build.distDir)}.tar.gz`);
    try {
      execFileSync("tar", ["-czf", archive, "-C", build.distDir, "."], { timeout: 60_000 });
      const root = `${remoteHome(host)}/.local/share/codecast/builds`;
      const destination = `${root}/${path.basename(build.distDir)}`;
      remoteExec(host, `mkdir -p ${shq(destination)}`, 30_000);
      log("uploading the Mac build…");
      scpTo(host, archive, `${destination}/dist.tar.gz`);
      const script = `${MAC_HOST_PATH}; set -e; tar -xzf ${shq(`${destination}/dist.tar.gz`)} -C ${shq(destination)}; rm ${shq(`${destination}/dist.tar.gz`)}; bun ${shq(`${destination}/main.js`)} --version`;
      const version = remoteExec(host, script, 60_000).trim();
      if (!version.split(/\s+/).includes(cliSourceVersion())) throw new Error(`The new Mac build did not report the expected version; the installed CLI is unchanged`);
      const wrapper = `#!/usr/bin/env bash\n${MAC_HOST_PATH}\nexec bun ${shq(`${destination}/main.js`)} "$@"\n`;
      const target = `${remoteHome(host)}/.local/bin/cast`;
      remoteExec(host, `mkdir -p ${shq(path.posix.dirname(target))}; if [ -e ${shq(target)} ] && [ ! -e ${shq(`${target}.before-source-update`)} ]; then cp -p ${shq(target)} ${shq(`${target}.before-source-update`)}; fi; printf %s ${shq(wrapper)} > ${shq(`${target}.next`)} && chmod 755 ${shq(`${target}.next`)} && mv ${shq(`${target}.next`)} ${shq(target)}`, 30_000);
      return version;
    } finally {
      fs.rmSync(archive, { force: true });
    }
  } finally {
    fs.rmSync(build.distDir, { recursive: true, force: true });
  }
}
