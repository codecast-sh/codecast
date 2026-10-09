import { waitStateWord, formatWaitTime } from "@codecast/shared/tasks";
import { relTimeShort } from "@codecast/shared/time";
const now = Date.now();
for (const h of [0.5, 1, 1.9, 2, 2.5, 26]) {
  const at = now + h * 3600000;
  const w: any = { id: "w1", kind: "time", at, state: "waiting", created_at: now, created_by: "u" };
  console.log(`${h}h away ->`, JSON.stringify(waitStateWord(w, { now })), "subject", JSON.stringify(formatWaitTime(at, { now })), "rel", relTimeShort(now, at));
}
