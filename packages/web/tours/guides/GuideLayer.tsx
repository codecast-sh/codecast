"use client";
// Mounted once in the dashboard layout: when the running tour is a guide, its
// player covers the app. The guides' scenes load only then.
import { lazy, Suspense } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { tourById } from "../registry";

const GuideById = lazy(() => import("./GuideById"));

export function GuideLayer() {
  const id = useInboxStore((s) => s.tour?.id ?? null);
  if (!id || tourById(id)?.kind !== "guide") return null;
  return <Suspense fallback={null}><GuideById id={id} /></Suspense>;
}
