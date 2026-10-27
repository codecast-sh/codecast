// A role's practical face on the phone (roleIcon.ts), the web's RoleIconTile
// drawn natively: its icon on a rounded square tinted with the icon's accent,
// or, for a role with no valid icon, the first letter of its title on the same
// tile. The colour recipe is the web's `.role-tile` color-mix, over the app's
// palette.
//
// The glyph is SvgXml of roleIconSvg's canonical markup, the one renderer, so
// nothing a model or an agent wrote reaches the screen unchecked.
// react-native-svg is in the frozen native baseline (lib/nativeDeps.guard.test.ts).
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { ROLE_ICON_TILE, roleIconStroke, roleIconSvg } from '@codecast/shared/contracts/roleIcon';
import type { RoleTile } from '@codecast/web/lib/sessionIdentity';
import { Text as RNText } from '@/components/Themed';
import { mixHex, useActiveScheme, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';

// The web's `.role-tile` recipe (app/globals.css): percent of the accent mixed
// into each base. Kept in one place so a web visual pass is one edit here.
const TILE_MIX = {
  fill: { light: 20, dark: 28 },   // into bgAlt
  border: { light: 45, dark: 45 }, // into bg
  ink: { light: 55, dark: 45 },    // into text
} as const;

export function MobileRoleIconTile({ tile, size = 20, label, style }: {
  tile: RoleTile;
  size?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const Theme = useTheme();
  const scheme = useActiveScheme();
  const accent = Theme[tile.accent];
  const ink = mixHex(accent, TILE_MIX.ink[scheme], Theme.text);
  let svg: string | null = null;
  // roleTile hands over only an icon that passed isRoleIcon; a row that slips
  // past it still draws, as its monogram.
  try { svg = tile.icon ? roleIconSvg(tile.icon, { strokeWidth: roleIconStroke(size), color: ink }) : null; } catch { svg = null; }
  const glyph = Math.round(size * ROLE_ICON_TILE.glyph);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label ?? tile.title}
      testID={`role-tile-${svg ? tile.icon!.concept : 'monogram'}`}
      style={[{
        width: size, height: size, flexShrink: 0, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
        borderRadius: size * ROLE_ICON_TILE.radius,
        backgroundColor: mixHex(accent, TILE_MIX.fill[scheme], Theme.bgAlt),
        borderWidth: 1, borderColor: mixHex(accent, TILE_MIX.border[scheme], Theme.bg),
      }, style]}
    >
      {svg ? (
        <SvgXml xml={svg} width={glyph} height={glyph} />
      ) : (
        <RNText
          style={{ fontFamily: Mono.semiBold, fontSize: size * 0.54, lineHeight: size * 0.7, letterSpacing: -0.02 * size * 0.54, color: ink }}
          maxFontSizeMultiplier={1}
        >
          {tile.monogram}
        </RNText>
      )}
    </View>
  );
}
