import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { OptionPreview } from "../../tools/AskUserQuestionToolView";
import { buildPollPayload, pollCardAnswers, pollClosedLabel, pollKeyForOption, POLL_TIMED_OUT, SYNTHETIC_POLL_OPTION, type PollQuestion, type PollSelection, type PollSelections } from "../../../lib/pollPayload";
import { ModernAnsweredRow, ModernAskCard } from "../ModernAsk";
import type { ToolCall, ToolResult } from "../types";

// An agent's AskUserQuestion in the Modern style (interactiveBlocks branches
// here). Open, it is the loud card: the question, the options as Buttons (the
// one Claude marks "(Recommended)" primary, the rest outline), a field for an
// answer in the person's own words, a Submit when the answers are picked
// first and sent together. Answered or closed, each question folds to one row
// with the choice at its right. The wire format is lib/pollPayload's, the
// same one the Classic card and the decision queue send.

// What this tab already sent for a question card, so a remount does not offer it again.
const sentByCall = new Map<string, PollSelections>();

const RECOMMENDED = " (Recommended)";
const clean = (label: string) => label.replace(RECOMMENDED, "");

type Deadline = { expired: boolean; left: string } | null | undefined;
type AskInput = { questions?: Array<PollQuestion & { multi_select?: boolean }>; answers?: Record<string, string> };

export function ModernAskUserQuestion({ tool, result, onSendMessage, parsedInput, deadline }: {
  tool: ToolCall;
  result?: ToolResult;
  onSendMessage?: (content: string) => void;
  parsedInput: AskInput;
  deadline?: Deadline;
}) {
  const [selections, setSelections] = useState<PollSelections>(() => sentByCall.get(tool.id) ?? {});
  const [sent, setSent] = useState(() => sentByCall.has(tool.id));
  const [texts, setTexts] = useState<Record<number, string>>({});

  const questions: PollQuestion[] = (parsedInput.questions ?? []).map((q) => ({ ...q, multiSelect: q.multiSelect ?? q.multi_select }));
  if (questions.length === 0) return null;
  const multiQuestion = questions.length > 1;
  const needsSubmit = multiQuestion || questions.some((q) => q.multiSelect);
  const answers = pollCardAnswers(questions, parsedInput.answers, result);
  const expired = !!deadline?.expired;
  // Still open: the card. Answerable only where this view can send (a shared
  // view reads the same card with its answers disabled).
  const open = !result && !sent && !expired;
  const interactive = open && !!onSendMessage;

  const send = (sels: PollSelections, payload = buildPollPayload(questions, sels)) => {
    sentByCall.set(tool.id, sels);
    setSelections(sels);
    setSent(true);
    onSendMessage!(payload);
  };

  if (!open) {
    const closed = expired ? POLL_TIMED_OUT : pollClosedLabel(result, answers);
    return (
      <div data-cc-ask-settled>
        {questions.map((q, i) => {
          const picked = answers[q.question] ?? selections[i]?.map((s) => s.label).join(", ");
          return (
            <ModernAnsweredRow
              key={i}
              verb={closed && !picked ? "Asked" : "Answered"}
              question={q.question}
              answer={picked ? picked.replace(RECOMMENDED, "") : closed ?? (sent ? "Sent" : undefined)}
              closed={!picked}
            />
          );
        })}
      </div>
    );
  }

  const pick = (qi: number, sel: PollSelection) => {
    const q = questions[qi];
    if (q.multiSelect) {
      setSelections((prev) => {
        const cur = prev[qi] ?? [];
        const has = cur.some((s) => s.text === undefined && s.key === sel.key);
        return { ...prev, [qi]: has ? cur.filter((s) => s.text !== undefined || s.key !== sel.key) : [...cur, sel] };
      });
    } else if (needsSubmit) {
      setSelections((prev) => ({ ...prev, [qi]: [sel] }));
    } else {
      send({ 0: [sel] }, JSON.stringify({ __cc_poll: true, keys: [sel.key], display: sel.label }));
    }
  };
  const typed = (qi: number) => {
    const text = texts[qi]?.trim();
    if (!text) return;
    const sel = { key: String(questions[qi].options.length + 1), label: text, text };
    setTexts((prev) => ({ ...prev, [qi]: "" }));
    if (questions[qi].multiSelect) setSelections((prev) => ({ ...prev, [qi]: [...(prev[qi] ?? []).filter((s) => s.text === undefined), sel] }));
    else if (needsSubmit) setSelections((prev) => ({ ...prev, [qi]: [sel] }));
    else send({ 0: [sel] });
  };
  const answered = questions.filter((_, qi) => (selections[qi]?.length ?? 0) > 0).length;
  const allAnswered = answered === questions.length;

  return (
    <div data-cc-ask-question-card>
      {questions.map((q, qi) => {
        const sels = selections[qi] ?? [];
        const rich = q.options.some((o) => o.description || o.preview);
        const custom = sels.find((s) => s.text !== undefined);
        return (
          <ModernAskCard
            key={qi}
            kicker={q.header}
            aside={qi === 0 && deadline ? `Auto-denies in ${deadline.left}` : multiQuestion ? `${qi + 1} of ${questions.length}` : undefined}
            question={q.question}
            detail={q.detail}
          >
            <div className={rich ? "flex flex-col items-start gap-2" : "flex flex-wrap gap-2"}>
              {q.options.map((opt, j) => {
                if (SYNTHETIC_POLL_OPTION.test(opt.label.trim())) return null;
                const key = pollKeyForOption(j, q.isConfirmation);
                const on = sels.some((s) => s.text === undefined && s.key === key);
                const recommended = opt.label.includes(RECOMMENDED);
                const button = (
                  <Button
                    type="button"
                    size="md"
                    variant={on ? "secondary" : recommended ? "primary" : "outline"}
                    aria-pressed={needsSubmit ? on : undefined}
                    disabled={!interactive}
                    onClick={() => pick(qi, { key, label: clean(opt.label) })}
                    className="max-w-full"
                  >
                    {on && <Check aria-hidden />}
                    <span className="truncate">{clean(opt.label)}</span>
                  </Button>
                );
                if (!rich) return <span key={j} className="contents">{button}</span>;
                return (
                  <div key={j} className="flex min-w-0 max-w-full flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      {button}
                      {opt.description && <span className="min-w-0 text-ui text-sol-text-muted">{opt.description}</span>}
                    </div>
                    {opt.preview && <OptionPreview preview={opt.preview} />}
                  </div>
                );
              })}
            </div>
            {interactive && <form
              className="mt-3 flex min-w-0 items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); typed(qi); }}
            >
              <Input
                value={texts[qi] ?? ""}
                onChange={(e) => setTexts((prev) => ({ ...prev, [qi]: e.target.value }))}
                placeholder={custom ? custom.label : "Answer in your own words"}
                aria-label="Answer in your own words"
                className="h-control-md min-w-0 flex-1 text-ui"
              />
              <Button type="submit" size="md" variant="outline" disabled={!texts[qi]?.trim()}>
                {needsSubmit ? "Add" : "Send"}
              </Button>
            </form>}
            {custom && needsSubmit && <div className="mt-2 text-meta text-sol-text-muted">Your answer: <span className="text-sol-text">{custom.label}</span></div>}
          </ModernAskCard>
        );
      })}
      {needsSubmit && interactive && (
        <div className="-mt-0.5 mb-2 flex justify-end">
          <Button type="button" size="md" variant="primary" disabled={!allAnswered} onClick={() => send(selections)}>
            {multiQuestion ? `Submit answers ${answered}/${questions.length}` : `Submit ${selections[0]?.length ?? 0} selected`}
          </Button>
        </div>
      )}
    </div>
  );
}
