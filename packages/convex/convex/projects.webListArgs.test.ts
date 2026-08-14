// The web client spreads its workspace args ({workspace, team_id,
// project_path}) into workspace-wide queries. projects.webList must accept
// every field of that shape — a validator that rejects project_path crashes
// any deployed client that sends it (ArgumentValidationError in the Sidebar).
import { describe, expect, test } from "bun:test";
import { webList } from "./projects";

describe("projects.webList args", () => {
  test("accepts the full client workspace-args shape", () => {
    const spec = JSON.parse((webList as any).exportArgs());
    for (const field of ["workspace", "team_id", "project_path", "status"]) {
      expect(spec.value[field]).toBeDefined();
      expect(spec.value[field].optional).toBe(true);
    }
  });
});
