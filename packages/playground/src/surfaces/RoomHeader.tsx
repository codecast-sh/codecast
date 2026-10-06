// The room's header (DESIGN 6.3): the app, live version, who is here, links,
// you, close.
import { useState } from "react";
import { useCopy } from "../lib/clipboard";
import { useIdentity } from "../lib/identity";
import { absolute, appUrl, navigate, roomUrl, versionUrl } from "../lib/router";
import { IconButton } from "../ui/Button";
import { Face } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { CloseIcon, LinkIcon } from "../ui/icons";
import { LiveDot } from "../ui/LiveDot";
import { Popover } from "../ui/Popover";
import { useAppState } from "./appState";
import s from "./RoomHeader.module.css";

export function RoomHeader({ compact = false }: { compact?: boolean }) {
  const { app, here, setRoomOpen, openCharacterPicker } = useAppState();
  const { me } = useIdentity();
  const [menu, setMenu] = useState<null | { kind: "people" | "links"; anchor: HTMLElement }>(null);
  const toggle = (kind: "people" | "links", anchor: HTMLElement) => setMenu((m) => (m?.kind === kind ? null : { kind, anchor }));

  return (
    <header className={`${s.head} ${compact ? s.compact : ""}`}>
      <div className={s.titleCol}>
        <h2 className={s.name} title={app.name}>{app.name}</h2>
        <p className={s.sub}>
          <LiveDot />
          <span className={s.ver}>v{app.live_version}</span>
          <span>{here.people.length} here</span>
          {app.forked_from && (
            <a className={s.lineage} href={appUrl(app.forked_from.slug)} onClick={(e) => {
              e.preventDefault();
              navigate(appUrl(app.forked_from!.slug));
            }}>
              forked from {app.forked_from.name} v{app.forked_from.version}
            </a>
          )}
        </p>
      </div>
      <div className={s.tools}>
        {!compact && (
          <button className={s.stack} onClick={(e) => toggle("people", e.currentTarget)} aria-label="Who is here">
            <FaceStack people={here.people} max={3} size={30} typing={here.typing} />
          </button>
        )}
        <IconButton label="Copy a link" onClick={(e) => toggle("links", e.currentTarget)}>
          <LinkIcon />
        </IconButton>
        <button className={s.you} onClick={openCharacterPicker} aria-label="Change your character" title="That's you">
          <Face person={me} size={36} />
        </button>
        <IconButton label="Close the room" onClick={() => setRoomOpen(false)}>
          <CloseIcon />
        </IconButton>
      </div>
      {menu?.kind === "people" && (
        <Popover anchor={menu.anchor} width={260} onClose={() => setMenu(null)}>
          <PeopleList />
        </Popover>
      )}
      {menu?.kind === "links" && (
        <Popover anchor={menu.anchor} width={320} onClose={() => setMenu(null)}>
          <LinkMenu />
        </Popover>
      )}
    </header>
  );
}

function PeopleList() {
  const { here } = useAppState();
  const { me } = useIdentity();
  return (
    <ul className={s.people}>
      {here.people.map((p) => {
        const row = here.byId.get(p.id);
        const status = here.typing.has(p.id) ? "typing" : row?.viewing_version ? `viewing v${row.viewing_version}` : null;
        return (
          <li key={p.id}>
            <Face person={p} size={30} />
            <b>{p.name}</b>
            {p.id === me.id && <span className={s.you2}>you</span>}
            {status && <span className={s.status}>{status}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function LinkMenu() {
  const { app, viewing } = useAppState();
  const { copied, copy } = useCopy();
  const shown = viewing ?? app.live_version;
  const rows = [
    { key: "app", label: "App link", url: absolute(appUrl(app.slug)) },
    { key: "room", label: "Room link", url: absolute(roomUrl(app.slug)) },
    { key: "version", label: `This version, v${shown}`, url: absolute(versionUrl(app.slug, shown)) },
  ];
  return (
    <ul className={s.links}>
      {rows.map((r) => (
        <li key={r.key}>
          <button onClick={() => copy(r.key, r.url)}>
            <b>{copied === r.key ? "Copied" : r.label}</b>
            <code>{r.url.replace(/^https?:\/\//, "")}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}
