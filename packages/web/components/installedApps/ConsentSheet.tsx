// The one consent sheet for installed apps: installing a page, a running
// app's cast.app.permissions.request, and the re-ask after a new version
// (docs/architecture/installed-apps.md "Desktop bridge for the web app"). It
// is the shared consequential review: the page's address heads it, then the
// app as the person will see it in their Dock, then one switch per thing the
// moment asks for, and the confirm names the act.
import { useState } from "react";
import type { AppPermission } from "@codecast/shared/contracts/pageApp";
import { pageShareUrl } from "@codecast/shared/entities";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { consentGrants, consentLedger, consentToggles, madeBy, pageAddress, type ConsentRequest } from "../../lib/installedApps";
import { AppIcon } from "./AppIcon";
import { PermissionToggles } from "./PermissionToggles";

const currentPlatform = () => (typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent) ? "win32" : "darwin");

export function ConsentSheet({ req, onAnswer, fill = true }: {
  req: ConsentRequest;
  onAnswer: (approve: boolean, grants: AppPermission[]) => void;
  /** The sheet is its window (the consent route); false floats it over a page. */
  fill?: boolean;
}) {
  const [toggles] = useState(() => consentToggles(req));
  const [chosen, setChosen] = useState<Set<AppPermission>>(() => new Set(toggles.filter((t) => t.on).map((t) => t.perm)));
  const { info } = req;
  const ledger = consentLedger(req, chosen, pageAddress(pageShareUrl(info.slug)));
  const rows = toggles.map((t) => ({ ...t, on: chosen.has(t.perm) }));
  const flip = (perm: AppPermission, on: boolean) => setChosen((prev) => {
    const next = new Set(prev);
    if (on) next.add(perm); else next.delete(perm);
    return next;
  });
  return (
    <SwitchReview
      ledger={ledger}
      fill={fill}
      // A sheet opened over another app: a click meant for that app, or a double click, cannot land on the confirm.
      armAfterMs={500}
      onClose={() => onAnswer(false, [])}
      onConfirm={() => onAnswer(true, consentGrants(req, chosen))}
    >
      <div className="flex items-center gap-4 border-b border-sol-border/60 px-5 py-4" data-consent-app={info.slug}>
        <AppIcon src={info.icons["512"]} name={info.app.name} size={64} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[18px] font-semibold leading-tight text-sol-text" data-consent-name>{info.app.name}</span>
          <span className="truncate text-[12.5px] text-sol-text-muted" data-consent-owner>{madeBy(info)}</span>
          <span className="text-meta tabular-nums text-sol-text-dim">v{info.version}</span>
        </div>
      </div>
      {rows.length > 0 && (
        <PermissionToggles
          rows={rows}
          platform={currentPlatform()}
          onFlip={flip}
          idPrefix={`consent-${req.id}`}
        />
      )}
    </SwitchReview>
  );
}
