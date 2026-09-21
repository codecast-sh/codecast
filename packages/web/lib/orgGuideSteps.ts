import { staffingPaneWord } from "../components/org/orgMeta";

export type OrgGuideStep = {
  id: string;
  /** A CSS selector for the control the step highlights; null = no highlight. */
  target: string | null;
  sentence: string;
  /** The last step's main button, when it does more than close: opening the
   *  proposal that is already waiting. The page maps the id to the act. */
  action?: { id: "open_proposal"; label: string };
};

/** The quick tour of the page's parts (S14, reshaped under S20): one
 *  sentence and one highlight each, in this order: the chart, a role card,
 *  the Proposal or Health button, Add a role, Words. Runs straight after the
 *  first visit and again from "How this page works". The role step is
 *  skipped when the workspace has no role card to point at; the third step
 *  says what the button opens, so with a proposal waiting it names it and
 *  its own button opens it. */
export function orgGuideSteps({ meNodeId, roleNodeId, openProposal }: { meNodeId: string | null; roleNodeId?: string | null; openProposal?: { short_id: string; remaining: number } | null }): OrgGuideStep[] {
  const steps: OrgGuideStep[] = [
    {
      id: "chart",
      target: meNodeId ? `.react-flow__node[data-id="${meNodeId}"]` : null,
      sentence: "The chart is who reports to whom: you, the roles you hired, every session. Drag a card to move it.",
    },
  ];
  if (roleNodeId) {
    steps.push({
      id: "role",
      target: `.react-flow__node[data-id="${roleNodeId}"]`,
      sentence: "A role card: hover it to see what the role looks after, double click to open it.",
    });
  }
  steps.push(openProposal ? {
    id: "proposals",
    target: '[data-org-guide="staffing"]',
    sentence: `${staffingPaneWord(true)} opens the one waiting for you, ${openProposal.short_id}, as a conversation with ${openProposal.remaining === 1 ? "one change" : `${openProposal.remaining} changes`} to decide.`,
    action: { id: "open_proposal", label: `Open ${openProposal.short_id}` },
  } : {
    id: "proposals",
    target: '[data-org-guide="staffing"]',
    sentence: `${staffingPaneWord(false)} shows how the company is doing and starts the next proposal.`,
  });
  steps.push({
    id: "hire",
    target: '[data-org-guide="hire"]',
    sentence: "Add a role hires one by hand; its sessions then report to it instead of to you.",
  });
  steps.push({
    id: "words",
    target: "[data-org-glossary-open]",
    sentence: "Words defines the eight words this page uses, one sentence each.",
  });
  return steps;
}
