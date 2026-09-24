// Which face the palette window paints: the command palette ("search") or the
// new-session popup ("compose").
//
// The face lives in the palette page's React state, and that state starts as
// "search". The shell asks for a face over IPC and shows the window only when
// the page confirms it painted that face, so the previous face never flashes
// before the swap. A fallback timer shows the window anyway if no confirmation
// comes, so it can never stay hidden.
//
// The page reloads on its own: a deploy reloads it the moment it hides, and a
// stale chunk reloads it wherever it is. A request sent while the new document
// is still booting reaches no listener, and the new document paints "search"
// with no memory of what was open. So the shell holds the face it wants until
// the page confirms that exact face, and asks again whenever the page confirms
// a different one. The page mounts its listeners before it confirms, so the
// second ask always lands.
//
// Policy only, so it can be tested without an Electron app: main.js feeds it
// the page's confirmations and new documents and does what it says.

const CHANNEL = { compose: "compose-show", search: "palette-show" };

function createPaletteFace({ send, reveal, isVisible, fallbackMs = 200 }) {
  let wanted = null; // asked for, not yet confirmed painted
  let revealing = false; // the window waits for a confirmation to show
  let painted = "search"; // the face the page shows; every document is born on search
  let fallback = null;

  function finishReveal() {
    // No confirmation came, but the page already shows what was asked: web
    // builds that confirm only a CHANGE of face stay silent on a repeat ask.
    if (wanted === painted) wanted = null;
    revealing = false;
    clearTimeout(fallback);
    fallback = null;
    reveal();
  }

  return {
    show(face) {
      wanted = face;
      revealing = true;
      clearTimeout(fallback);
      fallback = setTimeout(() => { if (revealing) finishReveal(); }, fallbackMs);
      send(CHANNEL[face]);
    },
    // `face` is undefined from web builds older than the face in the ack; trust those.
    ready(face) {
      if (face && wanted && face !== wanted) {
        send(CHANNEL[wanted]);
        return;
      }
      painted = face || wanted || painted;
      wanted = null;
      if (revealing) finishReveal();
    },
    // A new document boots on "search". If the person is looking at the
    // palette, or about to, it must come back on the face they had.
    newDocument() {
      if (revealing || isVisible()) wanted = wanted || painted;
      painted = "search";
    },
    // A dismissed palette wants nothing: a late confirmation must neither show
    // the window nor push a face into the hidden page.
    hide() {
      wanted = null;
      revealing = false;
      clearTimeout(fallback);
      fallback = null;
    },
  };
}

module.exports = { createPaletteFace };
