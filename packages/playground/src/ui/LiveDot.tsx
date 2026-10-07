import { useState } from "react";
import s from "./LiveDot.module.css";

/** A small static green dot: live. A new `ping` (a go-live while mounted)
 *  pings it once. */
export function LiveDot({ ping = 0 }: { ping?: number }) {
  const [mountedAt] = useState(ping);
  const pinging = ping !== mountedAt;
  return <span key={pinging ? ping : 0} className={`${s.dot} ${pinging ? s.ping : ""}`} aria-hidden />;
}
