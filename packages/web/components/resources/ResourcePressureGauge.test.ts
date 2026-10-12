import { expect, test } from "bun:test";
import { levelOf } from "./ResourcePressureGauge";

test("the gauge takes a tone only for critical pressure or an incident past ten minutes", () => {
  const now = 3_600_000;
  expect(levelOf(null, now)).toBe("calm");
  expect(levelOf({ level: "elevated", since: now - 4 * 60_000, reason: "CPU use has stayed above 90%" }, now)).toBe("calm");
  expect(levelOf({ level: "elevated", since: now - 10 * 60_000, reason: "CPU use has stayed above 90%" }, now)).toBe("elevated");
  expect(levelOf({ level: "critical", since: now - 60_000, reason: "The operating system reports critical memory pressure" }, now)).toBe("critical");
});
