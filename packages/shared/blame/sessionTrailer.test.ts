import { describe, expect, test } from "bun:test";
import { extractSessionTrailer, sessionTrailerValue, SESSION_TRAILER_KEY } from "./index";

const ID = "jx7bq5kz13a2eypp4a6vdqznas7zvrw2";
const trailer = `${SESSION_TRAILER_KEY}: ${sessionTrailerValue(ID)}`;

describe("session trailer", () => {
  test("value is the canonical session link", () => {
    expect(sessionTrailerValue(ID)).toBe(`https://codecast.sh/conversation/${ID}`);
  });

  test("reads the trailer from the last paragraph", () => {
    expect(extractSessionTrailer(`fix: thing\n\nbody text\n\n${trailer}\n`)).toBe(ID);
    expect(extractSessionTrailer(`fix: thing\n\nCo-Authored-By: x <x@y>\n${trailer}`)).toBe(ID);
  });

  test("a subject-only commit with just the trailer block", () => {
    expect(extractSessionTrailer(`fix\n\n${trailer}`)).toBe(ID);
  });

  test("ignores a trailer quoted in the body", () => {
    expect(extractSessionTrailer(`docs: explain\n\n${trailer}\n\nMore prose here.`)).toBeNull();
  });

  // GitHub's default squash message, as it lands on main (layout from a real
  // squash in this repository): each commit's full message as a bullet, then
  // a separator and the co-author trailers GitHub appends.
  test("reads trailers out of a GitHub squash merge", () => {
    const other = "jx71y3pbzq5dvrr08xybrbd2ad7ztmaq";
    const second = `${SESSION_TRAILER_KEY}: ${sessionTrailerValue(other)}`;
    const coAuthors = "---------\n\nCo-authored-by: Jason Benn <jason@union.app>\nCo-authored-by: Ashot <a@b.c>";
    expect(extractSessionTrailer(`feat: x (#21)\n\n* feat: x\n\nwhy it changed\n\n${trailer}\n\n${coAuthors}\n`)).toBe(ID);
    // Several commits: the last trailer in the list is the newest commit's.
    expect(extractSessionTrailer(`feat: x (#21)\n\n* one\n\n${trailer}\n\n* two\n\nbody\n\n${second}\n\n${coAuthors}`)).toBe(other);
    // A later commit with no trailer still leaves the earlier commit's.
    expect(extractSessionTrailer(`feat: x (#21)\n\n* one\n\n${trailer}\n\n* two\n\n${coAuthors}`)).toBe(ID);
    // Without co-authors GitHub adds no separator.
    expect(extractSessionTrailer(`feat: x (#21)\n\n* one\n\n${trailer}\n\n* two`)).toBe(ID);
  });

  test("a trailer quoted in prose, or as a lone example paragraph mid-body, still names nothing", () => {
    expect(extractSessionTrailer(`docs: explain\n\nThe hook adds a line like\n${trailer}\n\nMore prose.`)).toBeNull();
    expect(extractSessionTrailer(`docs: explain\n\nFor example:\n\n${trailer}\n\nwhich blame reads.`)).toBeNull();
    // Inside a squash, a bullet's prose that quotes the trailer is not a trailer block.
    expect(extractSessionTrailer(`feat (#2)\n\n* one\n\nsee ${trailer}\n\n* two`)).toBeNull();
  });

  test("key is case-insensitive, bare full ids and local hosts work", () => {
    expect(extractSessionTrailer(`x\n\ncodecast-session: ${ID}`)).toBe(ID);
    expect(extractSessionTrailer(`x\n\nCodecast-Session: http://localhost:3200/conversation/${ID}`)).toBe(ID);
  });

  test("the last of several trailers wins", () => {
    const other = "jx71y3pbzq5dvrr08xybrbd2ad7ztmaq";
    expect(extractSessionTrailer(`x\n\n${trailer}\nCodecast-Session: ${sessionTrailerValue(other)}`)).toBe(other);
  });

  test("refuses short ids, other objects and foreign hosts", () => {
    expect(extractSessionTrailer("x\n\nCodecast-Session: https://codecast.sh/conversation/jx7bq5k")).toBeNull();
    expect(extractSessionTrailer("x\n\nCodecast-Session: https://codecast.sh/tasks/ct-1")).toBeNull();
    expect(extractSessionTrailer(`x\n\nCodecast-Session: https://evil.example/conversation/${ID}`)).toBeNull();
    expect(extractSessionTrailer("")).toBeNull();
    expect(extractSessionTrailer(null)).toBeNull();
  });
});
