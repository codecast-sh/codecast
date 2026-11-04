"use client";
// /share/card/<token>: someone's week with coding agents, the card itself and
// the way to make your own. The same picture the link unfurls to.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { WEEK_CARD_INSTALL, WEEK_CARD_SITE_URL } from "@codecast/shared/contracts/weeklyCard";
import { WeekCardFrame } from "../../../../components/weeklyCard/WeekCardFrame";
import { SharedObjectPage } from "../../SharedObjectPage";

type Shared = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedCard>>;

export default function SharedCardPage() {
  return (
    <SharedObjectPage<Shared> kind="card" query={api.publicShare.getSharedCard} noun="week" wide>
      {(c) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <WeekCardFrame stats={c.stats} name={c.user?.name ?? null} />
          <div className="share-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginTop: 0 }}>
            <a className="share-copy" href={WEEK_CARD_SITE_URL}>Get your own week</a>
            <code style={{ userSelect: "all" }}>{WEEK_CARD_INSTALL}</code>
          </div>
        </div>
      )}
    </SharedObjectPage>
  );
}
