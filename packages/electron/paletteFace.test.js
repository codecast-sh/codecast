const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPaletteFace } = require("./paletteFace");

// A stand-in for app/palette/page.tsx: born on "search", listens for the two
// channels only once React has mounted, and confirms every face it paints.
// A reload drops the listeners until the new document mounts.
function rig(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const page = { mounted: true, mode: "search", visible: false, reveals: 0 };
  const face = createPaletteFace({
    send: (channel) => {
      sent.push(channel);
      if (!page.mounted) return;
      const next = channel === "compose-show" ? "compose" : "search";
      // compose-show always remounts the popup; palette-show only repaints on a change.
      if (next === "compose" || next !== page.mode) {
        page.mode = next;
        face.ready(next);
      }
    },
    reveal: () => {
      page.visible = true;
      page.reveals += 1;
    },
    isVisible: () => page.visible,
  });
  page.startReload = () => { page.mounted = false; };
  page.commit = () => face.newDocument();
  page.mount = () => {
    page.mounted = true;
    page.mode = "search";
    face.ready("search");
  };
  page.switchInPage = (mode) => {
    page.mode = mode;
    face.ready(mode);
  };
  page.dismiss = () => {
    face.hide();
    page.visible = false;
  };
  return { face, page, sent };
}

test("a plain open paints the asked face and reveals once", (t) => {
  const { face, page } = rig(t);
  face.show("compose");
  t.mock.timers.tick(500);
  assert.equal(page.mode, "compose");
  assert.equal(page.reveals, 1);
});

test("New Session pressed while the page reloads still opens compose", (t) => {
  const { face, page } = rig(t);
  page.startReload();
  face.show("compose");
  t.mock.timers.tick(200);
  page.commit();
  page.mount();
  t.mock.timers.tick(500);
  assert.equal(page.mode, "compose");
  assert.equal(page.visible, true);
});

test("a reload while compose is open comes back on compose", (t) => {
  const { face, page } = rig(t);
  face.show("compose");
  assert.equal(page.mode, "compose");
  page.startReload();
  page.commit();
  page.mount();
  assert.equal(page.mode, "compose");
});

test("the page switching itself to compose is not undone", (t) => {
  const { face, page, sent } = rig(t);
  face.show("search");
  face.show("search"); // already on search: this page stays silent
  t.mock.timers.tick(200);
  page.switchInPage("compose");
  assert.equal(page.mode, "compose");
  assert.deepEqual(sent, ["palette-show", "palette-show"]);
});

test("a reload after dismissal does not push a face into the hidden page", (t) => {
  const { face, page, sent } = rig(t);
  face.show("compose");
  page.dismiss();
  page.startReload();
  page.commit();
  page.mount();
  assert.deepEqual(sent, ["compose-show"]);
  assert.equal(page.visible, false);
  face.show("compose");
  assert.equal(page.mode, "compose");
});

test("a late confirmation after dismissal does not show the window", (t) => {
  const { face, page } = rig(t);
  page.mounted = false;
  face.show("compose");
  page.dismiss();
  t.mock.timers.tick(500);
  page.mounted = true;
  face.ready("compose");
  assert.equal(page.visible, false);
});
