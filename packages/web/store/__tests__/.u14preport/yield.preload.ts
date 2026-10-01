import { afterAll } from "bun:test";
const t0 = Bun.nanoseconds(); const c0 = process.cpuUsage();
afterAll(() => { const u = process.cpuUsage(c0); console.log(`[yield] ${JSON.stringify((globalThis as any).__yield)} totalWall=${((Bun.nanoseconds() - t0) / 1e6).toFixed(0)} totalCpu=${((u.user + u.system) / 1000).toFixed(0)}`); });
