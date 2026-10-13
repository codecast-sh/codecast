import { describe, expect, test } from "bun:test";
import { routeLines } from "./routeCommand";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("cast route output", () => {
  test("a landing names the owner, the line, the task and the woken session", () => {
    const lines = routeLines({ owner: { kind: "role", handle: "cold-email", name: "Cold Email lead", role_id: "r1" }, line: 2, why: "@cold-email names its plan", dry: false, task: { short_id: "ct-9" }, woke: { short_id: "jx7abcd" } }).map(strip);
    expect(lines).toEqual(["✓ → @cold-email · line 2: @cold-email names its plan", "  task ct-9, @cold-email woken in jx7abcd"]);
  });
  test("a dry run says so and a router answer carries its confidence", () => {
    const lines = routeLines({ owner: { kind: "user", user_id: "u1" }, line: 4, why: "nothing else fits", confidence: 0.91, dry: true }).map(strip);
    expect(lines).toEqual(["dry → you · line 4: nothing else fits (91% sure)"]);
  });
  test("an unsure router lists the choices and how to pick", () => {
    const lines = routeLines({ owner: null, line: 4, why: "two roles could claim it", confidence: 0.55, dry: false, choices: [{ handle: "growth", confidence: 0.55, reason: "its plan names acquisition" }, { handle: "cold-email", confidence: 0.4, reason: "sender health" }] }).map(strip);
    expect(lines[0]).toBe("Nobody yet · line 4: two roles could claim it (55% sure)");
    expect(lines.slice(1)).toEqual(["Choices:", "  1. @growth (55%)  its plan names acquisition", "  2. @cold-email (40%)  sender health", 'Pick one with: cast route --to @<handle> "<the request>"']);
  });
});
