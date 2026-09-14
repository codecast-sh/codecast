import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The task hover card and the shared object card name who holds a task and
// who filed it on one line. One person who filed a task for themselves is
// named once; two people read as the assignee, then "filed by" the creator.

const { useInboxStore } = await import("../store/inboxStore");
const { TaskPeople } = await import("./entityDisplay");

const ME = { _id: "u_me", name: "Ashot", github_username: "ashot", image: null };
const ADA = { _id: "u_ada", name: "Ada", github_username: "ada", image: null };
useInboxStore.setState({ currentUser: ME, teamMembers: [ME, ADA] } as any);

const count = (html: string, s: string) => html.split(s).length - 1;

test("one person who filed a task for themselves is named once", () => {
  const html = renderToStaticMarkup(<TaskPeople task={{ user_id: ME._id, assignee: ME._id }} />);
  expect(count(html, "Ashot")).toBe(1 + 1); // the name, plus its avatar's alt/initial
  expect(html).not.toContain("filed by");
  expect(html).toContain('title="Filed by and assigned to Ashot"');
});

test("two people read as the assignee, then filed by the creator", () => {
  const html = renderToStaticMarkup(<TaskPeople task={{ user_id: ADA._id, assignee: ME._id }} />);
  expect(html.indexOf("Ashot")).toBeLessThan(html.indexOf("Ada"));
  expect(html).toContain("filed by");
  expect(html).toContain('title="Assigned to Ashot, filed by Ada"');
});

test("an unassigned task still names who filed it", () => {
  const html = renderToStaticMarkup(<TaskPeople task={{ user_id: ADA._id }} />);
  expect(html).toContain("Unassigned");
  expect(html).toContain("filed by");
  expect(html).toContain("Ada");
});

test("nothing renders when nobody is known", () => {
  expect(renderToStaticMarkup(<TaskPeople task={{}} />)).toBe("");
});
