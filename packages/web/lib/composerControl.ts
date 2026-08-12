// Reaching the message composer from outside it. The composer lives deep inside
// MessageInput; anything that wants to hand the user back to it (the compose.focus
// shortcut, the quote rail's "Write reply" / "Send" actions) goes through here so
// there is ONE way to find it and ONE way to submit it.
//
// The textarea carries `data-chat-input`; submitting goes through its own <form>,
// so the send path is exactly the one Enter takes — including the review batch
// that handleSubmit auto-attaches.

function composerInput(): HTMLTextAreaElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
}

export function focusComposer(): boolean {
  const el = composerInput();
  if (!el) return false;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
  return true;
}

export function sendComposer(): boolean {
  const form = composerInput()?.closest("form");
  if (!form) return false;
  form.requestSubmit();
  return true;
}
