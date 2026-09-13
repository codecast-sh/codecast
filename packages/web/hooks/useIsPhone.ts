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
