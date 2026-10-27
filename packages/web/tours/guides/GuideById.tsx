"use client";
import { GuidePlayer } from "./GuidePlayer";
import { GUIDES } from "./guides";

export default function GuideById({ id }: { id: string }) {
  const guide = GUIDES.find((g) => g.id === id);
  return guide ? <GuidePlayer key={id} guide={guide} /> : null;
}
