import { describe, expect, test } from "bun:test";
import { parsePollAnswers } from "../pollPayload";

const q = (question: string, ...labels: string[]) => ({ question, options: labels.map(label => ({ label })) });

describe("parsePollAnswers", () => {
  test("a question holding quotes still finds its answer", () => {
    const question = q('Does "deploy all" include Union production, or just codecast?', "Codecast only", "Codecast and Union");
    const content = 'Your questions have been answered: "Does "deploy all" include Union production, or just codecast?"="Codecast only". You can now continue with these answers in mind.';
    expect(parsePollAnswers([question], content)).toEqual({ [question.question]: "Codecast only" });
  });

  test("an option label holding quotes, followed by a preview with quotes", () => {
    const question = q("Which style?", 'Use "inverted" cards', "Plain");
    const content = 'Your questions have been answered: "Which style?"="Use "inverted" cards" selected preview:\n"x"="y". You can now continue with these answers in mind.';
    expect(parsePollAnswers([question], content)).toEqual({ "Which style?": 'Use "inverted" cards' });
  });

  test("several questions, a multi-select join and a custom answer", () => {
    const a = q("First?", "A", "B");
    const b = q("Second?", "X", "Y");
    const c = q("Third?", "M", "N");
    const content = 'Your questions have been answered: "First?"="A, B", "Second?"="X", "Third?"="something else". You can now continue with these answers in mind.';
    expect(parsePollAnswers([a, b, c], content)).toEqual({ "First?": "A, B", "Second?": "X", "Third?": "something else" });
  });

  test("no result, or an unanswered question, yields nothing", () => {
    expect(parsePollAnswers([q("First?", "A")], undefined)).toEqual({});
    expect(parsePollAnswers([q("First?", "A")], "User declined to answer questions")).toEqual({});
  });
});
