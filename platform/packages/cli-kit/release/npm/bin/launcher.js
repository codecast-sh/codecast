#!/usr/bin/env node
// Thin launcher: runs the compiled binary, downloading it first if the
// postinstall was skipped (npm --ignore-scripts, some CI setups).
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { install, binaryPath } = require("../install.js");

const BINARY_NAME = "acme"; // rename

async function main() {
  let bin = binaryPath();
  if (!fs.existsSync(bin)) {
    console.error(`${BINARY_NAME}: downloading binary (first run)...`);
    bin = await install();
  }
  const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

main().catch((err) => {
  console.error(`${BINARY_NAME}: ${err.message}`);
  process.exit(1);
});
