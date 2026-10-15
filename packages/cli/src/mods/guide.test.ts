import { describe, expect, test } from "bun:test";
import { formatModGuide } from "./guide";

describe("mod guide for agents", () => {
  test("an external kind is named by id with nothing to create; a stored kind keeps its create verb", () => {
    const text = formatModGuide([{
      name: "union", title: "Union", fences: [],
      objects: [
        { prefix: "contact", title: "Contact", fields: ["role"], external: true },
        { prefix: "bug", title: "Bug", fields: [] },
      ],
    }]);
    expect(text).toContain("nothing to create first): contact-<id>");
    expect(text).not.toContain("cast obj create contact");
    expect(text).toContain("cast obj create bug");
  });
});
