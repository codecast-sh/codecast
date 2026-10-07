import { useId, type ReactNode } from "react";
import s from "./Tip.module.css";

/** A small tooltip for the positioned control it sits in, shown on hover or
 *  keyboard focus after a beat; never on touch, where hover doesn't exist.
 *  It describes its control rather than naming it: the control spreads
 *  `describedBy`, and the tip itself stays out of the control's name. */
export function useTip(content: ReactNode, side: "above" | "below" = "above") {
  const id = useId();
  return {
    describedBy: { "aria-describedby": id },
    tip: <span id={id} className={`${s.tip} ${s[side]}`} aria-hidden>{content}</span>,
  };
}
