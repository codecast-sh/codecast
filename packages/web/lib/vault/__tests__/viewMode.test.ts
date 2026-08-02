// The two pieces of memory behind the three view modes. Both are small enough
// to look obvious and both have a wrong version that feels broken: forgetting
// the per-file mode drops you out of an edit when you glance at another note,
// and forgetting the global one drags a source-mode user back through live
// preview in every note they open for the first time.

import { test, expect, describe, beforeEach } from "bun:test";
import {
  resetVaultViewModes,
  setVaultViewMode,
  toggleVaultEditMode,
  toggleVaultSourceMode,
  vaultViewMode,
} from "../viewMode";

beforeEach(resetVaultViewModes);

describe("per-file memory", () => {
  test("a note starts in reading mode", () => {
    expect(vaultViewMode("a.md")).toBe("reading");
    expect(vaultViewMode(null)).toBe("reading");
  });

  test("each note keeps its own mode", () => {
    setVaultViewMode("a.md", "source");
    setVaultViewMode("b.md", "reading");
    expect(vaultViewMode("a.md")).toBe("source");
    expect(vaultViewMode("b.md")).toBe("reading");
  });
});

describe("the edit chord", () => {
  test("reading goes to live preview by default, and back", () => {
    expect(toggleVaultEditMode("a.md")).toBe("live");
    expect(toggleVaultEditMode("a.md")).toBe("reading");
  });

  test("someone who works in source gets source, even in a new note", () => {
    setVaultViewMode("a.md", "source");
    expect(toggleVaultEditMode("b.md")).toBe("source");
  });

  test("returning to live preview makes live preview the default again", () => {
    setVaultViewMode("a.md", "source");
    setVaultViewMode("a.md", "live");
    expect(toggleVaultEditMode("b.md")).toBe("live");
  });

  test("leaving for reading mode does not forget how you were editing", () => {
    setVaultViewMode("a.md", "source");
    toggleVaultEditMode("a.md"); // → reading
    expect(toggleVaultEditMode("a.md")).toBe("source");
  });
});

describe("the source chord", () => {
  test("from reading it jumps straight to the raw file", () => {
    expect(toggleVaultSourceMode("a.md")).toBe("source");
  });

  test("from source it drops back into live preview", () => {
    setVaultViewMode("a.md", "source");
    expect(toggleVaultSourceMode("a.md")).toBe("live");
  });

  test("from live preview it shows the source", () => {
    setVaultViewMode("a.md", "live");
    expect(toggleVaultSourceMode("a.md")).toBe("source");
  });

  test("it also sets the mode the edit chord will return to", () => {
    toggleVaultSourceMode("a.md");
    expect(toggleVaultEditMode("b.md")).toBe("source");
  });
});
