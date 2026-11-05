#!/usr/bin/env bun
// Writes the web's snapshots of the shipped pool of flows and their stations (src/workflow/shippedFlows.ts).
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_FLOWS_SNAPSHOT_PATH, SHIPPED_FLOW_STATIONS_SNAPSHOT_PATH, renderShippedFlowsModule, renderShippedFlowStationsModule } from "../src/workflow/shippedFlows";

for (const [rel, render] of [[SHIPPED_FLOWS_SNAPSHOT_PATH, renderShippedFlowsModule], [SHIPPED_FLOW_STATIONS_SNAPSHOT_PATH, renderShippedFlowStationsModule]] as const) {
  const out = path.resolve(import.meta.dir, "../../..", rel);
  fs.writeFileSync(out, render());
  console.log(`wrote ${out}`);
}
