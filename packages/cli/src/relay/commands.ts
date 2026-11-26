import type { Command } from "commander";
import { commandGroup } from "../commandGroupLookup.js";
import { relayMain, registerMain, unregisterMain } from "./wiring.js";
import { defaultConfigDir } from "../config/configDir.js";
import { readAuthConfig } from "../config/readAuthConfig.js";

const readConfig = () => readAuthConfig(defaultConfigDir(), { onUnreadable: (m) => console.error(m) });

export function registerRegisterCommand(program: Command): void {
  program
    .command("register")
    .description(commandGroup("register").description)
    .option("--session-id <id>", "Claude session id (default: from the hook payload on stdin)")
    .option("--cwd <dir>", "Working directory (default: from the hook payload on stdin)")
    .action(async (options) => {
      process.exit(await registerMain({ sessionId: options.sessionId, cwd: options.cwd }, readConfig));
    });
}

export function registerUnregisterCommand(program: Command): void {
  program
    .command("unregister")
    .description(commandGroup("unregister").description)
    .option("--session-id <id>", "Claude session id (default: from the hook payload on stdin)")
    .action(async (options) => {
      process.exit(await unregisterMain({ sessionId: options.sessionId }, readConfig));
    });
}

export function registerRelayCommand(program: Command): void {
  program
    .command("relay")
    .description(commandGroup("relay").description)
    .option("--background", "Start the relay detached unless one is already running")
    .option("--stop", "Stop the running relay")
    .action(async (options) => {
      process.exit(await relayMain({ background: options.background, stop: options.stop }, readConfig));
    });
}
