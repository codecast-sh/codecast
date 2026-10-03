// The deployment and the person the e2e scripts act as, through an admin
// client acting as that person (scripts/rig/stack.mjs): the local dev
// deployment and the smoke world's Jordan by default, and the App Review
// Jordan on prod only when RIG_DEPLOYMENT=prod says so.
import { adminClient, localDeployment, prodDeployment } from "../scripts/rig/stack.mjs";
import { IDENTITIES } from "../scripts/rig/auth.mjs";
import { seedWorld } from "../scripts/rig/seed.mjs";

export const dep = process.env.RIG_DEPLOYMENT === "prod" ? prodDeployment("The e2e scripts") : localDeployment();
export const userId: string = dep.kind === "prod" ? IDENTITIES.jordan.id : (await seedWorld(dep)).jordan;
export const client = adminClient(dep, userId);
