"use client";
import { Check, CircleDot, MessageSquare } from "lucide-react";
import type { ToolViewProps } from "@/lib/toolRegistry";

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

function parseAnswers(input: any, output: any): Record<string, string> {
  if (input?.answers && typeof input.answers === "object") {
    return input.answers;
  }
  if (!output) return {};
  const text = typeof output === "string" ? output : output?.content || output?.text || "";
  const answers: Record<string, string> = {};
  const regex = /"([^"]+)"="([^"]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    answers[match[1]] = match[2];
  }
  return answers;
}

function QuestionBlock({ question, answer }: { question: Question; answer?: string }) {
  const isAnswered = answer !== undefined;
  const isCustomAnswer = isAnswered && !question.options.some(
    o => o.label === answer || o.label.replace(" (Recommended)", "") === answer
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {question.header && (
          <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20">
            {question.header}
          </span>
        )}
      </div>
      <div className="text-sm text-foreground/90">{question.question}</div>
      <div className="space-y-1 pl-1">
        {question.options.map((opt, i) => {
          const cleanLabel = opt.label.replace(" (Recommended)", "");
          const isSelected = isAnswered && (opt.label === answer || cleanLabel === answer);
          return (
            <div
              key={i}
              className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                isSelected
                  ? "bg-emerald-500/10 border border-emerald-500/30"
                  : "text-muted-foreground"
              }`}
            >
              <div className="mt-0.5 flex-shrink-0">
                {isSelected ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <CircleDot className="w-3.5 h-3.5 opacity-30" />
                )}
              </div>
              <div>
                <span className={isSelected ? "text-foreground font-medium" : ""}>
                  {opt.label}
                </span>
                {opt.description && (
                  <span className="text-xs text-muted-foreground block mt-0.5">
                    {opt.description}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {isCustomAnswer && (
          <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-md text-sm bg-blue-500/10 border border-blue-500/30">
            <div className="mt-0.5 flex-shrink-0">
              <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
            </div>
            <div>
              <span className="text-foreground font-medium">{answer}</span>
              <span className="text-xs text-muted-foreground block mt-0.5">Custom response</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AskUserQuestionToolView({ input, output }: ToolViewProps) {
  const questions: Question[] = input?.questions || [];
  const answers = parseAnswers(input, output);

  if (questions.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground italic">
        No questions
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        return <QuestionBlock key={i} question={q} answer={answer} />;
      })}
    </div>
  );
}
