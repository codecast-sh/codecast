#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("code-chat-sync")
  .description("Sync coding agent conversations to a shared Convex database")
  .version("0.1.0");

program
  .command("setup")
  .description("Configure code-chat-sync with authentication and team settings")
  .action(() => {
    console.log("Setup command - not yet implemented");
  });

program
  .command("start")
  .description("Start the background daemon to watch and sync conversations")
  .action(() => {
    console.log("Start command - not yet implemented");
  });

program
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    console.log("Stop command - not yet implemented");
  });

program
  .command("status")
  .description("Show daemon status and sync information")
  .action(() => {
    console.log("Status command - not yet implemented");
  });

program
  .command("sync")
  .description("Manually sync all unsynced conversations")
  .action(() => {
    console.log("Sync command - not yet implemented");
  });

program
  .command("config")
  .description("View or modify configuration")
  .argument("[key]", "Configuration key to get or set")
  .argument("[value]", "Value to set")
  .action((key, value) => {
    console.log("Config command - not yet implemented");
  });

program
  .command("logs")
  .description("View daemon logs")
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .action((options) => {
    console.log("Logs command - not yet implemented");
  });

program
  .command("private")
  .description("Manage private conversations")
  .argument("[session-id]", "Session ID to mark as private")
  .option("--list", "List all private conversations")
  .option("--remove", "Remove private flag from conversation")
  .action((sessionId, options) => {
    console.log("Private command - not yet implemented");
  });

program.parse();
