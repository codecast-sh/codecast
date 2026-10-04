import type { ComponentType } from "react";
import BrowserPage from "./browser/Page";
import ComputerPage from "./computer/Page";
import PublishPage from "./publish/Page";
import TriggersPage from "./triggers/Page";
import AgentsPage from "./agents/Page";
import MemoryPage from "./memory/Page";
import DecisionsPage from "./decisions/Page";
import PullRequestsPage from "./pull-requests/Page";
import CloudPage from "./cloud/Page";
import CallsPage from "./calls/Page";

/** Each deep dive's body, keyed by its slug in catalog.ts. A page owns everything below the nav. */
export const FEATURE_PAGES: Record<string, ComponentType> = {
  "browser": BrowserPage,
  "computer": ComputerPage,
  "publish": PublishPage,
  "triggers": TriggersPage,
  "agents": AgentsPage,
  "memory": MemoryPage,
  "decisions": DecisionsPage,
  "pull-requests": PullRequestsPage,
  "cloud": CloudPage,
  "calls": CallsPage,
};
