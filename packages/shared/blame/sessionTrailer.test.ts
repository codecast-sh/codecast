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
