// Generated-api stand-in: every `api.module.fn` reads as the string
// "module:fn", which the query mock keys its fixtures on.
export const api: any = new Proxy({}, {
  get: (_t, mod) => new Proxy({}, { get: (_t2, fn) => `${String(mod)}:${String(fn)}` }),
});
