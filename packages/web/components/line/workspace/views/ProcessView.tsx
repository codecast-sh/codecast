"use client";
// The Line page's steps as a map (line-journeys.md LJ8.5). The table mode has
// no page of its own yet, so both modes draw the map.
import { GraphView } from "./GraphView";
import type { LineViewProps } from "./types";

export function ProcessView(props: LineViewProps) {
  return <GraphView {...props} />;
}
