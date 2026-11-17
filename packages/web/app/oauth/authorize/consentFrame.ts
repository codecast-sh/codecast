// The consent page grants an outside agent access with one confirmed press, so
// it never renders inside another page: a framing site could dress it in a
// decoy and steer the press. The server forbids framing by header
// (server/responsePolicy isUnframeablePath); this is the same refusal where no
// header applies (the dev server, a cached shell).
export function isFramed(win: Window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}
