import { describe, test, expect } from "bun:test";
import { detectPermissionPrompt } from "./permissionDetector.js";

describe("Permission Detector", () => {
  test("detects basic permission prompt with [y/n]", () => {
    const content = "Allow execution? [y/n]";
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBeTruthy();
  });

  test("detects Bash tool permission prompt", () => {
    const content = "Do you want to allow bash command 'ls -la'? [y/n]";
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBe("Bash");
  });

  test("detects Edit tool permission prompt", () => {
    const content = "Allow edit to file /path/to/file.ts? [y/n]";
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBe("Edit");
  });

  test("detects Read tool permission prompt", () => {
    const content = "Permission required to read file /secret/data.txt [y/n]";
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBe("Read");
  });

  test("extracts arguments preview", () => {
    const content = "Allow bash command:\nrm -rf /important/data\nProceed? [y/n]";
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.arguments_preview).toContain("rm -rf");
  });

  test("returns null for non-permission content", () => {
    const content = "Here is some regular assistant response text.";
    const result = detectPermissionPrompt(content);
    expect(result).toBeNull();
  });

  test("returns null for message without [y/n] prompt", () => {
    const content = "I need permission to do this task, but I'm just explaining.";
    const result = detectPermissionPrompt(content);
    expect(result).toBeNull();
  });

  test("handles multiline permission prompt", () => {
    const content = `I need to run a bash command to check the status.

Command: git status

Allow this command? [y/n]`;
    const result = detectPermissionPrompt(content);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBe("Bash");
    expect(result?.arguments_preview).toContain("git status");
  });
});
