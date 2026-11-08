// A person's answer to an AskUserQuestion or an ExitPlanMode, as the web sends
// it (a __cc_poll message built for the terminal menu, pollMessage.ts), read
// as the answer the SDK's canUseTool returns. The keys mean what they mean in
// the menu: a digit picks that option of the current question, a multiSelect
// question's digits toggle until Right moves on, and Enter submits.

import { pollDeclineText, pollMenuSteps, type PollMessage } from "../pollMessage.js";
import type { SdkPermissionAnswer } from "./protocol.js";

interface Question {
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string }>;
}

/** The answer an AskUserQuestion takes from a poll, or null when the poll answers nothing. */
export function askAnswerFromPoll(input: Record<string, unknown>, poll: PollMessage): SdkPermissionAnswer | null {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
  if (!questions.length) return null;
  // Prose instead of picks: the terminal declines the menu and types the text,
  // so the agent reads the person's own words. Here the words go back as the tool's answer.
  const prose = pollDeclineText(poll);
  if (prose !== null) {
    if (!prose) return { behavior: "deny", message: "The user dismissed the question." };
    return { behavior: "deny", message: `The user answered in their own words instead of picking an option: ${prose}` };
  }
  const answers: Record<string, string> = {};
  let q = 0;
  let picks: string[] = [];
  const close = () => {
    if (q < questions.length && picks.length) answers[questions[q].question] = picks.join(", ");
    picks = [];
    q++;
  };
  for (const { key } of pollMenuSteps(poll)) {
    if (q >= questions.length) break;
    const question = questions[q];
    if (/^\d+$/.test(key)) {
      const option = question.options[Number(key) - 1];
      if (!option) continue;
      if (question.multiSelect) {
        if (!picks.includes(option.label)) picks.push(option.label);
        else picks = picks.filter((p) => p !== option.label);
      } else {
        picks = [option.label];
        close();
      }
    } else if (key === "Right" || key === "Tab") {
      close();
    }
  }
  if (picks.length) close();
  if (!Object.keys(answers).length) return null;
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

/**
 * The answer an ExitPlanMode takes from the plan card. The web offers "start"
 * (keys 1, 2 or 3, with or without clearing context) and "request changes"
 * (4 with text). Starting returns the session to the mode it was in before
 * plan mode, so a bypass session stays bypass; with no record of it, edits are
 * approved one by one. The SDK has no "clear context" variant, so starting
 * keeps the context.
 */
export function planAnswerFromPoll(poll: PollMessage, modeBeforePlan?: string | null): SdkPermissionAnswer | null {
  const keys = pollMenuSteps(poll).map((s) => s.key);
  if (keys[0] === "4" || (poll.text && !keys.length)) {
    const feedback = (poll.text ?? "").trim();
    return { behavior: "deny", message: feedback ? `The user wants changes to the plan: ${feedback}` : "The user wants changes to the plan." };
  }
  if (keys[0] !== "1" && keys[0] !== "2" && keys[0] !== "3") return null;
  const mode = (modeBeforePlan && modeBeforePlan !== "plan" ? modeBeforePlan : "default") as "default";
  return { behavior: "allow", updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
}

/** The tools whose prompt is a question for the person, not a permission. */
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Tools the web shows no card for (PERMISSION_SKIP_TOOLS there), whose ask the
 * terminal path answers through its pane: entering plan mode and the task list.
 * With no pane, an SDK session allows them outright; none acts on the world.
 */
export const AUTO_ALLOW_TOOLS = new Set(["EnterPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
