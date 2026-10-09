"use client";

import { QueueStage, SessionsPanel } from "../../../features/decisions/Hero";
import { PhoneQueue } from "../../../features/decisions/Sections";
import "../../../features/decisions/decisions.css";

/**
 * Figures for the decisions guide, drawn with the decisions feature page's own
 * pieces: the queue clearing in one sitting while the asking sessions wake,
 * and the same queue on the phone.
 */

/** Three asks stacked in Questions; each answer wakes the session that asked. */
export function QueueClearingFigure() {
  return (
    <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start">
      <SessionsPanel />
      <QueueStage />
    </div>
  );
}

/** The iPhone app walks the same queue, one decision at a time. */
export function PhoneQueueFigure() {
  return (
    <div className="flex justify-center p-4 sm:p-6">
      <PhoneQueue />
    </div>
  );
}
