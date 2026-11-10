// What the service worker may precache. Under assets/, plugins/precacheScope.ts
// narrows it further to what the app reaches (no grammar, icon or marketing
// chunks); outside it, these patterns decide. Blog and docs media, the social
// banners (brand/) and the homepage hero's stills (hero/) are the public site's.
export const APP_SHELL_GLOB_PATTERNS = ["**/*.{js,css,html,ico,png,svg,woff2}"];
export const APP_SHELL_GLOB_IGNORES = ["docs/**", "blog/**", "brand/**", "hero/**"];
