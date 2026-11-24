import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { recoveringWebSocket } from "@codecast/shared/network";
import { deviceId } from "../remote/device.js";
import { realAncestorComms, realGitRemote, readStdinBounded, runRegister, runUnregister, type RegisterDeps, type RegisterOptions } from "./registerCommand.js";
import { createTargetAdapter } from "./targets.js";
import { realRuntimeDeps, runRelayCommand, type RelayConvexClient } from "./relayCommand.js";

type Config = RegisterDeps["config"];
type ConfigReader = () => Config;

function safeConfig(read: ConfigReader): Config {
  try {
    return read();
  } catch {
    return null;
  }
}

function realRegisterDeps(config: Config): RegisterDeps {
  return {
    config,
    env: process.env,
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
    readStdin: () => readStdinBounded(),
    ancestorComms: () => realAncestorComms(),
    identify: (target) => createTargetAdapter().identify(target),
    gitRemote: realGitRemote,
    deviceId,
    cwd: () => process.cwd(),
    makeClient: (url) => new ConvexHttpClient(url) as any,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

export async function registerMain(opts: RegisterOptions, read: ConfigReader): Promise<number> {
  return runRegister(opts, realRegisterDeps(safeConfig(read)));
}

export async function unregisterMain(opts: RegisterOptions, read: ConfigReader): Promise<number> {
  return runUnregister(opts, realRegisterDeps(safeConfig(read)));
}

export async function relayMain(opts: { background?: boolean; stop?: boolean }, read: ConfigReader): Promise<number> {
  const makeClient = (url: string): RelayConvexClient =>
    new ConvexClient(url, { webSocketConstructor: recoveringWebSocket({ completeMissingClose: true }) }) as any;
  return runRelayCommand(opts, realRuntimeDeps(() => safeConfig(read), deviceId(), makeClient));
}
