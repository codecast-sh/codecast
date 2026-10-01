import { projector } from "./project";
import { cameraAt } from "./timeline";
import { localToWorld, SURFACES } from "./world";
const cpu = () => process.cpuUsage().user / 1000;
for (let rep = 0; rep < 3; rep++) {
let a = cpu();
for (let k = 0; k < 2664; k++) cameraAt(k / 30);
let b = cpu();
let z = 0;
for (let k = 0; k < 2664; k++) { const at = projector(cameraAt(k / 30).pose); for (const s of SURFACES) for (let j = 0; j < 8; j++) { const p = at(localToWorld(s.id, 10, 20, 0)); if (p) z += p.x; } }
let c = cpu();
console.log("camera", b - a, "camera+proj", c - b, z > 0);
}
