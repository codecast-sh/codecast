import { afterAll, afterEach, beforeEach } from "bun:test";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const t0 = cpu(); let s = 0; const rows: string[] = [];
let wall = 0;
beforeEach(() => { s = cpu(); wall = performance.timeOrigin + 0; });
afterEach(() => { rows.push(`${(cpu() - s).toFixed(0).padStart(6)}ms`); });
afterAll(() => { console.log(`[cpu] tests: ${rows.join(" ")} | before first test ${(rows.length ? "" : "")}total ${(cpu() - t0).toFixed(0)}ms`); });
