// Custom entry so web-global polyfills run before ANY route module.
// expo-router's route context evaluates "(tabs)/*" before "_layout" (paren
// sorts first), so a polyfill import inside _layout is too late for modules
// like lib/calls/callManager that touch DOMException at eval time.
import "./lib/polyfills";
import "expo-router/entry";
