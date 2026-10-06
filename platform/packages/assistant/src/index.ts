/**
 * @platform/assistant: the storage-free half of a hosted assistant. Plans,
 * wallet arithmetic, approval rules, the system prompt, and the mail,
 * calendar and web tools over an injected transport (a WhiskCall, a page
 * reader, a Messages API post). The app keeps storage and wiring. See README.md.
 *
 * The leaf subpaths (plans, wallet, zone, text, whisk, messages) import
 * nothing, and steps imports only the dependency-free @platform/agent/outcome,
 * so a web or phone bundle can load them without the harness.
 */
export * from "./plans";
export * from "./wallet";
export * from "./zone";
export * from "./text";
export * from "./messages";
export * from "./steps";
export * from "./whisk";
export * from "./rules";
export * from "./prompt";
export * from "./mail";
export * from "./calendar";
export * from "./whiskEngine";
export * from "./web";
