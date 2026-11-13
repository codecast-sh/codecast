// Custom entry so web-global polyfills run before ANY route module.
// expo-router's route context evaluates "(tabs)/*" before "_layout" (paren
// sorts first), so a polyfill import inside _layout is too late for modules
// like lib/calls/callManager that touch DOMException at eval time.
import "./lib/polyfills";
import { bootMark } from "./lib/bootProfile";
import { startBootFonts } from "./lib/bootFonts";
import { installCachePrincipal } from "./lib/cachePrincipal";
bootMark("after-polyfills");
startBootFonts();
// Before any route module loads the store: its first paint reads the disk
// cache synchronously, and that read must know whose cache it may serve.
installCachePrincipal();
require("expo-router/entry");
