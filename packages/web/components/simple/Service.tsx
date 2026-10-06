// One thing the mail connection lets the assistant do (email, calendar) as a
// row: an icon, a name and what it means for the person. Connections shows
// whether each is on; /welcome, before anything is connected, shows the row
// without a state.
import type { ReactNode } from "react";
import { LANE_COPY } from "./lane";

export function Service({ icon, title, on, children }: { icon: ReactNode; title: string; on?: boolean; children: ReactNode }) {
  return (
    <div className="sl-service">
      <span className={`sl-service-icon${on === false ? " is-sun" : ""}`} aria-hidden>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <h3>
          {title}
          {on === undefined ? null : <span className={`sl-pill${on ? "" : " is-off"}`}>{on ? LANE_COPY.connections.on : LANE_COPY.connections.off}</span>}
        </h3>
        <p>{children}</p>
      </div>
    </div>
  );
}
