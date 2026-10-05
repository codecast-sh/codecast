// The browser's "not allowed" for media, in a leaf with no imports: the call
// engine asks it of a refused camera or microphone (callMedia), and the
// recording player asks it of a refused play() (CallVideoPlayer), which the
// share page loads without the call engine.

/** Did the browser refuse the device, as opposed to not having one? A
 *  SecurityError (an insecure origin, a permissions policy) is a refusal too:
 *  the device exists and nothing on this page can open it. The same
 *  NotAllowedError is what a phone browser answers a play() with sound made
 *  outside a tap. */
export const isMediaDenial = (err: any): boolean =>
  err?.name === "NotAllowedError" || err?.name === "SecurityError";
