"use client";

import { SOL } from "../../../blog/blogChrome";
import { ForkHistoryMock, InboxNestMock } from "../../../features/agents/mocks";

/**
 * Figures for the forks and sessions guide, drawn with the agents feature
 * page's own pieces: workers nested under the session that started them, and
 * a fork carrying the history into each branch.
 */

/** A parent session in the inbox with its workers nested under it. */
export function InboxNestFigure() {
  return (
    <div className="p-4 sm:p-6" style={{ backgroundColor: SOL.base3 }}>
      <InboxNestMock />
    </div>
  );
}

/** A fork: every branch gets the conversation so far, and none gets the request to fork. */
export function ForkFigure() {
  return (
    <div className="p-4 sm:p-6" style={{ backgroundColor: SOL.base3 }}>
      <ForkHistoryMock />
    </div>
  );
}
