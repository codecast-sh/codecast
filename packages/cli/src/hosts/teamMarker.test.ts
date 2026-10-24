import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTeamHostMarker } from "./teamMarker";

describe("the team machine marker", () => {
  test("absent off a shared host, empty when unregistered, and re-read when the box registers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marker-"));
    const file = path.join(dir, "shared-host");
    expect(readTeamHostMarker(file)).toBeNull();
    fs.writeFileSync(file, "admin=ubuntu\n");
    expect(readTeamHostMarker(file)).toEqual({ admin: "ubuntu" });
    fs.writeFileSync(file, `key=${"a".repeat(48)}\nadmin=ubuntu\nteam=t1\n`);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(readTeamHostMarker(file)?.key).toBe("a".repeat(48));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
