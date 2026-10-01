import type { CSSProperties } from "react";
import { Bell, Inbox, MessagesSquare, Settings, SquareCheck, type LucideIcon } from "lucide-react";
import {
  MOBILE_HEADER_STYLE,
  MOBILE_HEADER_TITLE_STYLE,
  MOBILE_TAB,
  MOBILE_TAB_BADGE_STYLE,
  MOBILE_TAB_BADGE_TEXT_STYLE,
  MOBILE_TAB_BAR_STYLE,
  MOBILE_TAB_ICON_SIZE,
  MOBILE_TAB_LABEL_STYLE,
  MOBILE_TABS,
  type MobileTabName,
} from "@codecast/shared/render/mobileTabsStyle";

/** The web's closest glyph to each FontAwesome icon the app's tab bar uses. */
const GLYPH: Record<(typeof MOBILE_TABS)[number]["icon"], LucideIcon> = {
  inbox: Inbox,
  comments: MessagesSquare,
  "check-square-o": SquareCheck,
  bell: Bell,
  cog: Settings,
};

/**
 * The mobile app's screen header (packages/mobile/app/(tabs)/_layout.tsx)
 * rendered with DOM elements from the same spec, for a tab screen whose
 * header the app shows. Colours are the theme's tokens, so it follows the
 * `.dark` the phone's screen carries.
 */
export function PhoneScreenHeader({ tab }: { tab: MobileTabName }) {
  return (
    <div
      className="flex h-11 shrink-0 items-center justify-center border-sol-border bg-sol-bg-alt px-4 font-mono"
      style={{ borderBottomWidth: MOBILE_HEADER_STYLE.borderBottomWidth, borderBottomStyle: "solid" }}
    >
      <span className="font-semibold text-sol-text" style={MOBILE_HEADER_TITLE_STYLE}>
        {MOBILE_TAB[tab].title}
      </span>
    </div>
  );
}

/** The mobile app's tab bar, from the same spec: every tab, the active one tinted, a count on any that carries one. */
export function PhoneTabBar({ active, badges }: { active: MobileTabName; badges?: Partial<Record<MobileTabName, number>> }) {
  return (
    <div
      className="flex shrink-0 border-sol-border bg-sol-bg-alt font-mono"
      style={{ ...MOBILE_TAB_BAR_STYLE, borderTopStyle: "solid", boxSizing: "border-box" }}
    >
      {MOBILE_TABS.map((t) => {
        const Glyph = GLYPH[t.icon];
        const badge = badges?.[t.name] ?? 0;
        return (
          <span key={t.name} className={`flex flex-1 flex-col items-center gap-1 ${t.name === active ? "text-sol-text" : "text-sol-text-dim"}`}>
            <span className="relative">
              <Glyph size={MOBILE_TAB_ICON_SIZE} strokeWidth={1.8} />
              {badge > 0 && (
                <span className="flex bg-sol-red" style={MOBILE_TAB_BADGE_STYLE as CSSProperties}>
                  <span className="tabular-nums leading-none" style={MOBILE_TAB_BADGE_TEXT_STYLE as CSSProperties}>{badge > 99 ? "99+" : badge}</span>
                </span>
              )}
            </span>
            <span className="font-medium leading-none" style={MOBILE_TAB_LABEL_STYLE}>{t.label}</span>
          </span>
        );
      })}
    </div>
  );
}
