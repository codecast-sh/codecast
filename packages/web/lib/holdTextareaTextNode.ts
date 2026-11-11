// React mirrors a controlled textarea's value into its defaultValue, and a
// textarea's defaultValue is its text node, so every keystroke replaced a
// child in the DOM. On a page with :has() rules, a tree change makes the
// browser re-check them across the page: 60 ms a key beside a long transcript
// (2026-10-22), where changing only the value costs under 1 ms.
//
// React writes a controlled box's value first and then sets defaultValue to
// the same text (updateTextarea). Skipping a defaultValue write that only
// repeats the live value removes that text-node change for every textarea in
// the app, and changes nothing anyone sees: once a box has been edited or
// given a value, its value is what renders. A write that differs (the first
// render's text, an uncontrolled box's new default) still goes through.
// Installed once at boot (src/main.tsx), before any box mounts.
export function holdTextareaTextNodes(win: { HTMLTextAreaElement: typeof HTMLTextAreaElement } = window): void {
  const proto = win.HTMLTextAreaElement.prototype as HTMLTextAreaElement & { __textNodeHeld?: true };
  if (proto.__textNodeHeld) return;
  const native = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "defaultValue");
  if (!native?.get || !native.set) return;
  const nativeSet = native.set;
  Object.defineProperty(proto, "defaultValue", {
    configurable: true,
    enumerable: native.enumerable,
    get: native.get,
    set(this: HTMLTextAreaElement, next: string) {
      if (String(next) === this.value) return;
      nativeSet.call(this, next);
    },
  });
  Object.defineProperty(proto, "__textNodeHeld", { value: true });
}
