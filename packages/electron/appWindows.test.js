const { test } = require("node:test");
const assert = require("node:assert/strict");
const { appForRoute, placeRoute, sectionForRoute, DESKTOP_APPS, isDesktopApp } = require("./appWindows.mjs");

test("appForRoute names the app by route prefix and ignores the query", () => {
  assert.equal(appForRoute("/chat"), "chat");
  assert.equal(appForRoute("/chat/ch1?m=msg9"), "chat");
  assert.equal(appForRoute("/community/room"), "chat");
  assert.equal(appForRoute("/threads"), "chat");
  assert.equal(appForRoute("/calls/c1"), "chat");
  assert.equal(appForRoute("/tasks/ct-1"), "work");
  assert.equal(appForRoute("/docs"), "work");
  assert.equal(appForRoute("/projects/p1/ct-2"), "work");
  assert.equal(appForRoute("/initiatives"), "work");
  assert.equal(appForRoute("/plans/pl-1"), "work");
  assert.equal(appForRoute("/inbox?s=c1"), null);
  assert.equal(appForRoute("/conversation/c1"), null);
  assert.equal(appForRoute("/chatter"), null);
  assert.equal(appForRoute("/tasksX"), null);
  assert.equal(appForRoute("/settings/team"), null);
  assert.equal(appForRoute(undefined), null);
});

test("every app's home and sections belong to that app", () => {
  for (const [name, app] of Object.entries(DESKTOP_APPS)) {
    assert.equal(appForRoute(app.home), name);
    for (const s of app.sections) assert.equal(appForRoute(s.path), name);
    assert.ok(app.title.length > 0);
  }
  assert.equal(isDesktopApp("chat"), true);
  assert.equal(isDesktopApp("people"), false);
  assert.equal(isDesktopApp("__proto__"), false);
});

test("sectionForRoute lights the tab the path sits under", () => {
  assert.equal(sectionForRoute("work", "/tasks/ct-1").label, "Tasks");
  assert.equal(sectionForRoute("chat", "/calls").label, "Calls");
  assert.equal(sectionForRoute("chat", "/threads"), null);
  assert.equal(sectionForRoute("nope", "/tasks"), null);
});

test("placeRoute: a main window keeps its own paths and hands app paths to an open app window", () => {
  assert.equal(placeRoute("/inbox", null, { chat: true, work: true }), "here");
  assert.equal(placeRoute("/chat/ch1", null, { chat: true }), "chat");
  assert.equal(placeRoute("/chat/ch1", null, { chat: false }), "here");
  assert.equal(placeRoute("/tasks", null, {}), "here");
  assert.equal(placeRoute("/tasks", null, { work: true }), "work");
});

test("placeRoute: an app window never shows a path outside its app", () => {
  assert.equal(placeRoute("/chat/ch1", "chat", {}), "here");
  assert.equal(placeRoute("/conversation/c1", "chat", { chat: true }), "main");
  assert.equal(placeRoute("/tasks/ct-1", "chat", { chat: true }), "main");
  assert.equal(placeRoute("/tasks/ct-1", "chat", { chat: true, work: true }), "work");
  assert.equal(placeRoute("/settings", "work", { work: true }), "main");
});
