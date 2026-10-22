#!/usr/bin/env bun
// Writes the web's snapshot of the shipped pool of flows (src/workflow/shippedFlows.ts).
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_FLOWS_SNAPSHOT_PATH, renderShippedFlowsModule } from "../src/workflow/shippedFlows";

const out = path.resolve(import.meta.dir, "../../..", SHIPPED_FLOWS_SNAPSHOT_PATH);
fs.writeFileSync(out, renderShippedFlowsModule());
console.log(`wrote ${out}`);
