// The room's header (DESIGN 6.3): the app, live version (or "Making" while
// Clay makes its first), who is here, links, you, close, and a quiet way to
// Clayground itself for someone who arrived on a shared link.
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { useCopy } from "../lib/clipboard";
import { errorData } from "../lib/errors";
import { useIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { absolute, appUrl, makeUrl, roomUrl, versionUrl } from "../lib/router";
import { Blob } from "../ui/Blob";
import { IconButton } from "../ui/Button";
import { Face } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { CloseIcon, LinkIcon } from "../ui/icons";
import { LiveDot } from "../ui/LiveDot";
import { Spinner } from "../ui/Spinner";
import { Popover } from "../ui/Popover";
import { Link } from "../ui/Link";
import { useToast } from "../ui/Toast";
import { useAppState, useHereState } from "./appState";
import s from "./RoomHeader.module.css";

export function RoomHeader({ compact = false }: { compact?: boolean }) {
  const { app, setRoomOpen, openCharacterPicker, cheer } = useAppState();
  const here = useHereState();
  const { me } = useIdentity();
  const [menu, setMenu] = useState<null | { kind: "people" | "links"; anchor: HTMLElement }>(null);
  // You already have the you chip beside it; the stack is everyone else.
  const others = here.people.filter((p) => p.id !== me.id);
  const toggle = (kind: "people" | "links", anchor: HTMLElement) => setMenu((m) => (m?.kind === kind ? null : { kind, anchor }));
  const mine = useIsMine();

  return (
    <header className={`${s.head} ${compact ? s.compact : ""}`}>
      <div className={s.top}>
        <h2 className={s.name} title={app.name}>{app.name}</h2>
        {compact && <span className={s.compactLive}><LiveVersion /></span>}
        {others.length > 0 && (
          <button
            className={s.stack}
            onClick={(e) => toggle("people", e.currentTarget)}
            aria-label={`${here.people.length} here. Who is here`}
            aria-haspopup="dialog"
            aria-expanded={menu?.kind === "people"}
          >
            <FaceStack people={others} max={compact ? 2 : 3} size={24} typing={here.typing} hop={cheer} />
            {!compact && <span className={s.names}>{others.length <= 2 ? others.map((p) => p.name).join(", ") : `${others.length} others`}</span>}
          </button>
        )}
        <IconButton label="Copy a link" onClick={(e) => toggle("links", e.currentTarget)} aria-haspopup="dialog" aria-expanded={menu?.kind === "links"}>
          <LinkIcon />
        </IconButton>
        <i className={s.divider} />
        <button className={s.you} onClick={openCharacterPicker} aria-label="You. Change your character" title="That's you">
          <Face person={me} size={28} />
        </button>
        <IconButton label="Close the room" onClick={() => setRoomOpen(false)}>
          <CloseIcon />
        </IconButton>
      </div>
      {!compact && (
        <p className={s.sub}>
          <LiveVersion long />
          <i className={s.sep} />
          <span className={s.tnum}>{here.people.length} here</span>
          {app.forked_from && (
            <>
              <i className={s.sep} />
              <Link className={s.lineage} to={appUrl(app.forked_from.slug)}>
                forked from {app.forked_from.name} v{app.forked_from.version}
              </Link>
            </>
          )}
          {!mine && <MakeYourOwn className={s.home} />}
        </p>
      )}
      {menu?.kind === "people" && (
        <Popover anchor={menu.anchor} width={260} onClose={() => setMenu(null)} label="Who is here">
          <PeopleList onDone={() => setMenu(null)} />
        </Popover>
      )}
      {menu?.kind === "links" && (
        <Popover anchor={menu.anchor} width={320} onClose={() => setMenu(null)} label="Links to this app">
          <LinkMenu makeYourOwn={compact && !mine} />
        </Popover>
      )}
    </header>
  );
}

/** Everyone here, you first. Someone looking at the past can be joined
 *  there in one click. */
function PeopleList({ onDone }: { onDone: () => void }) {
  const here = useHereState();
  const { me } = useIdentity();
  const { viewing, view } = useAppState();
  return (
    <ul className={s.people}>
      {here.people.map((p) => {
        const row = here.byId.get(p.id);
        const theirs = p.id === me.id ? null : (row?.viewing_version ?? null);
        const status = here.typing.has(p.id) ? "typing" : row?.viewing_version ? `viewing v${row.viewing_version}` : null;
        return (
          <li key={p.id}>
            <Face person={p} size={24} />
            <b>{p.name}</b>
            {p.id === me.id && <span className={s.you2}>you</span>}
            {theirs !== null && theirs !== viewing ? (
              <button
                className={s.lookWith}
                onClick={() => {
                  view(theirs);
                  onDone();
                }}
                title={`Look at v${theirs} with ${p.name}`}
              >
                viewing v{theirs} · <span className={s.lookLabel}>Look with {p.name}</span>
              </button>
            ) : (
              status && <span className={s.status}>{status}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What is live: "Live v14", "Viewing v2 · v14 is live" while you look at
 *  the past, or "Making" while Clay makes the first version (the starter
 *  under it is no version anyone asked for). */
function LiveVersion({ long = false }: { long?: boolean }) {
  const { landed, making, cheer, viewing } = useAppState();
  if (landed === 0) {
    return (
      <span className={s.making}>
        {making && <Spinner />}
        {making ? "Making" : "Not made yet"}
      </span>
    );
  }
  if (long && viewing !== null) {
    return (
      <>
        <span className={s.viewingV}>Viewing v{viewing}</span>
        <i className={s.sep} />
        <LiveDot ping={cheer} />
        <span className={s.ver}>v{landed} is live</span>
      </>
    );
  }
  return (
    <>
      <LiveDot ping={cheer} />
      <span className={s.ver}>{long ? "Live " : ""}v{landed}</span>
    </>
  );
}

/** You made this app or changed it: nothing to send you home for. */
function useIsMine(): boolean {
  const { app, timeline } = useAppState();
  const { me } = useIdentity();
  return app.created_by?.id === me.id || !!timeline?.some((v) => v.author?.id === me.id);
}

/** A quiet way home for whoever arrived on a shared link. */
function MakeYourOwn({ className }: { className: string }) {
  return (
    <Link className={className} to={makeUrl}>
      <Blob size={16} />
      Make your own
    </Link>
  );
}

/** `makeYourOwn`: the narrow header has no room for it, so the menu carries it. */
function LinkMenu({ makeYourOwn }: { makeYourOwn: boolean }) {
  const { app, viewing } = useAppState();
  const { copied, copy } = useCopy();
  const shown = viewing ?? app.live_version;
  // Copied links are the shell's own; an unfurler fetching one is handed the
  // app's preview (convex/lib/unfurl), so they unfurl as the app.
  const rows = [
    { key: "app", label: "App link", url: absolute(appUrl(app.slug)) },
    { key: "room", label: "Room link", url: absolute(roomUrl(app.slug)) },
    ...(shown > 0 ? [{ key: "version", label: `This version, v${shown}`, url: absolute(versionUrl(app.slug, shown)) }] : []),
  ];
  return (
    <ul className={s.links}>
      {rows.map((r) => (
        <li key={r.key}>
          <button onClick={() => copy(r.key, r.url)}>
            <b className={copied === r.key ? s.copied : ""}>{copied === r.key ? "Copied" : r.label}</b>
            <code>{r.url.replace(/^https?:\/\//, "")}</code>
          </button>
        </li>
      ))}
      {makeYourOwn && (
        <li className={s.makeRow}>
          <MakeYourOwn className={s.makeLink} />
        </li>
      )}
      <ReportRow version={shown} />
    </ul>
  );
}

/** "Report this app": flags it for a person to look at (SPEC "Safety"). */
function ReportRow({ version }: { version: number }) {
  const { app } = useAppState();
  const reported = useVisitorQuery(api.reports.reported, { app_id: app.id });
  const report = useVisitorMutation(api.reports.report);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <li className={s.report}>
      <button
        disabled={reported !== false || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await report({ app_id: app.id, version });
          } catch (err) {
            toast({ text: errorData(err).message });
          }
          setBusy(false);
        }}
      >
        <b>{reported ? "Reported" : "Report this app"}</b>
        <span>{reported ? "Thanks. A person will take a look." : "Flags it for a person to check"}</span>
      </button>
    </li>
  );
}
