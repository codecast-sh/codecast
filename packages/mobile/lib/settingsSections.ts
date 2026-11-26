// The settings sub-screens the phone has (/settings/<key>), with no React
// Native in it, so lib/linkRoutes can route a web settings link to one.
// components/settings/SettingsPages.tsx holds the page behind each key and
// fails to compile when the two lists differ.
export const MOBILE_SETTINGS_SECTIONS = [
  'profile',
  'notifications',
  'devices',
  'appearance',
  'security',
  'team',
  'vault',
  'about',
  'plan',
  'mail',
] as const;

export type MobileSettingsSection = (typeof MOBILE_SETTINGS_SECTIONS)[number];

export function isMobileSettingsSection(key: string): key is MobileSettingsSection {
  return (MOBILE_SETTINGS_SECTIONS as readonly string[]).includes(key);
}
