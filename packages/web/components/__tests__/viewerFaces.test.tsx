import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewerFaces } from "../presence/ViewerFaces";

const member = (id: string, name: string) => ({ _id: id, name, presence_state: "active" });

describe("ViewerFaces", () => {
  test("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<ViewerFaces members={[]} />)).toBe("");
  });

  test("one face per viewer up to the cap, then a +N, and a sentence for the hover and screen reader", () => {
    const html = renderToStaticMarkup(
      <ViewerFaces members={[member("a", "Ann Lee"), member("b", "Bob"), member("c", "Cy"), member("d", "Dan")]} max={3} size={14} />,
    );
    expect(html).toContain('data-sv-viewers="4"');
    expect(html).toContain("+1");
    expect(html).toContain('aria-label="Ann, Bob and 2 others are here"');
    expect(html).toContain('title="Ann, Bob and 2 others are here"');
    // Three faces drawn: the initials fallback carries each name as its title.
    expect(html).toContain('title="Ann Lee"');
    expect(html).toContain('title="Cy"');
    expect(html).not.toContain('title="Dan"');
  });

  test("a single viewer reads as one sentence with the full name", () => {
    const html = renderToStaticMarkup(<ViewerFaces members={[member("a", "Ann Lee")]} />);
    expect(html).toContain('aria-label="Ann Lee is here"');
    expect(html).not.toContain("+");
  });
});
