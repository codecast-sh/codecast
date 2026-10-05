#!/usr/bin/env bun
// Writes the web's snapshot of the shipped line graph (src/workflow/shippedLine.ts).
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_LINE_SNAPSHOT_PATH, renderShippedLineModule } from "../src/workflow/shippedLine";

const out = path.resolve(import.meta.dir, "../../..", SHIPPED_LINE_SNAPSHOT_PATH);
fs.writeFileSync(out, renderShippedLineModule());
console.log(`wrote ${out}`);
