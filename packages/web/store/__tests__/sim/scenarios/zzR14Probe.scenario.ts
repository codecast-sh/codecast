// Round 14 probe (temporary).
import { scenario } from "../dsl";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";

const KNOWN = { "INV-followers": "probe", "INV-fixpoint": "probe", "INV-pending-locks": "probe" };

for (const verb of ["kill", "stash"] as const) {
  scenario({ name: `r14ViewerTwoDevices_${verb}`, seeds: 3, known: KNOWN }, async (w) => {
    w.team("acme");
    w.user("ada", ["acme"]).user("bo", ["acme"]);
    const s = w.session("ada", "s", { agentStatus: "working" });
    await w.device("ada", {});
    const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
    const b2 = await w.device("bo", { scope: { team: "acme" } });
    await w.expect(b.followers[0]!).shows(s);
    await w.expect(b2.host).shows(s);
    if (verb === "kill") w.human(b.followers[0]!).kill(s); else w.human(b.followers[0]!).stash(s);
    await w.settle();
    await w.expect(b2.host).hides(s);
    w.human(b.followers[0]!).undo();
    await w.settle();
    await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
    await w.settle();
    for (const each of [...b.windows, ...b2.windows]) await w.expect(each).shows(s);
  });
}
