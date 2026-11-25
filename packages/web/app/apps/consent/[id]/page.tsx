"use client";

// /apps/consent/<id>: the installed-app consent sheet as a window of its own
// (docs/architecture/installed-apps.md "Desktop bridge for the web app").
// Main opens a small focused window here over the app that is asking, for all
// three moments: installing a page, a running app's permissions.request, and
// the re-ask after a new version. The page reads the request from main, shows
// the shared review edge to edge, answers once, and closes its window.
// Closing the window any other way is main's to count as a refusal.
import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { AppPermission } from "@codecast/shared/contracts/pageApp";
import { useDesktopApps } from "../../../../hooks/useInstalledApps";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { ConsentSheet } from "../../../../components/installedApps/ConsentSheet";
import type { ConsentRequest } from "../../../../lib/installedApps";

type Answered = { approve: boolean; name: string; kind: ConsentRequest["kind"] };

export default function AppConsentPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const apps = useDesktopApps();
  const [req, setReq] = useState<ConsentRequest | null | undefined>(undefined);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const sent = useRef(false);

  useWatchEffect(() => {
    if (!apps || !id) return;
    let live = true;
    apps.consent.get(id).then((r) => { if (live) setReq(r ?? null); }, () => { if (live) setReq(null); });
    return () => { live = false; };
  }, [apps, id]);

  const answer = (approve: boolean, grants: AppPermission[]) => {
    if (!apps || !req || sent.current) return;
    sent.current = true;
    setAnswered({ approve, name: req.info.app.name, kind: req.kind });
    void apps.consent.answer(id, { approve, grants }).finally(() => window.close());
  };

  return (
    <div className="flex h-[100dvh] items-center justify-center bg-sol-bg p-6 text-sol-text" data-app-consent={id}>
      {!apps ? (
        <Gone title="Open in Codecast" />
      ) : req === undefined ? null : req === null ? (
        <Gone title="This request has ended" />
      ) : answered ? (
        <Gone title={answered.approve ? (answered.kind === "install" ? `Installing ${answered.name}` : "Allowed") : answered.kind === "install" ? "Not installed" : "Not allowed"} />
      ) : (
        <ConsentSheet req={req} onAnswer={answer} />
      )}
    </div>
  );
}

/** What the window shows when there is nothing to answer, or once it has answered and is closing. */
function Gone({ title }: { title: string }) {
  return <p className="text-[15px] font-semibold text-sol-text-muted" data-consent-gone>{title}</p>;
}
