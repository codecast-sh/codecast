"use client";
// The card at any width: WeekCardView is drawn at its social-image size
// (1200x630) and scaled to the column, so the preview, the public page and
// the unfurl image are the same picture.
import { useRef, useState } from "react";
import type { WeekCardStats } from "@codecast/shared/contracts/weeklyCard";
import { useMountEffect } from "../../hooks/useMountEffect";
import { WeekCardView } from "./WeekCardView";
import { WEEK_CARD_H, WEEK_CARD_W } from "@codecast/shared/contracts/weeklyCard";

export function WeekCardFrame({ stats, name, className }: { stats: WeekCardStats; name: string | null; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useMountEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / WEEK_CARD_W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return (
    <div
      ref={box}
      className={`relative w-full overflow-hidden rounded-xl shadow-[0_18px_50px_-20px_rgba(0,0,0,0.6)] ${className ?? ""}`}
      style={{ aspectRatio: `${WEEK_CARD_W} / ${WEEK_CARD_H}` }}
      data-week-card={stats.week_key}
    >
      {scale > 0 && (
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: WEEK_CARD_W, height: WEEK_CARD_H }}>
          <WeekCardView stats={stats} name={name} />
        </div>
      )}
    </div>
  );
}
