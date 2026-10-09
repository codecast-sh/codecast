"use client";
// A person's header row on the canvas (essence spec §4.1): face, name, "you",
// and "online · 5 roles". Their roles follow in the band under it. Also the
// one face the canvas draws for whoever owns or leads something.
import { RoleFace } from "../RoleFace";
import type { CanvasFace, CanvasPerson } from "./canvasModel";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

/** A person's face: their photo, else their initials. */
export function PersonFace({ name, image, size, presence }: { name: string; image?: string; size: number; presence?: CanvasPerson["presence"] }) {
  return (
    <span className="oc-face" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} title={name} {...(presence ? { "data-presence": presence } : {})}>
      {image ? <img src={image} alt={name} /> : initials(name)}
    </span>
  );
}

/** Whoever owns or leads: a person's face or a role's animal, its name in the tooltip. */
export function Face({ face, size }: { face: CanvasFace; size: number }) {
  return face.kind === "role"
    ? <RoleFace role={{ handle: face.handle, avatar: face.avatar, name: face.name }} size={size} title={face.name} />
    : <PersonFace name={face.name} image={face.image} size={size} />;
}

const rolesWord = (n: number) => `${n} ${n === 1 ? "role" : "roles"}`;

export function PersonHeader({ person, roles, open, onOpen }: { person: CanvasPerson; roles: number; open: boolean; onOpen: () => void }) {
  const sub = [person.presence, roles ? rolesWord(roles) : null].filter(Boolean).join(" · ");
  return (
    <div className="oc-phead" data-canvas-person={person.id}>
      <button type="button" className="oc-phead-open" onClick={onOpen} {...(open ? { "data-open": "" } : {})}>
        <PersonFace name={person.name} image={person.image} size={40} presence={person.presence} />
        <span className="oc-pname">{person.name}</span>
      </button>
      {person.me && <span className="oc-you">you</span>}
      {sub && <span className="oc-psub">{sub}</span>}
    </div>
  );
}
