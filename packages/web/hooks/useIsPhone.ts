// Phone layout: the same 768px threshold DashboardLayout and
// useOpenLinkedSession use, as a live media query so a resize re-lays the page.
import { useState } from "react";
import { useMountEffect } from "./useMountEffect";

export const PHONE_MAX_WIDTH = 768;

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth < PHONE_MAX_WIDTH);
  useMountEffect(() => {
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH - 1}px)`);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return phone;
}

/** True while the viewport is at least `px` wide, as a live media query. The
 *  org page uses it to give a proposal's conversation its own column beside
 *  the change list only when both fit (org-staffing.md S18). */
export function useMinWidth(px: number): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= px);
  useMountEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return wide;
}
