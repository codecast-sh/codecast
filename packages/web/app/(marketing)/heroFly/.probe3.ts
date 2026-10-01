import { frame, presence } from "./timeline";
const c0 = process.cpuUsage();
presence("desk", 1, false);
const c1 = process.cpuUsage(c0);
presence("desk", 1, true);
const c2 = process.cpuUsage(c0);
let n = 0; const c3 = process.cpuUsage();
for (let t = 0; t < 88; t += 0.1) { frame(t); n++; }
const c4 = process.cpuUsage(c3);
console.log("desktop track ms", c1.user / 1000, "both", c2.user / 1000, "frame avg ms", c4.user / 1000 / n);
