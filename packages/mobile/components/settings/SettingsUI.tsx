import { Fragment, type ReactNode } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
  View as RNView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useActiveLook, useTheme } from '@/constants/Theme';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

/** The family look draws a row's icons in Feather's thin stroke, as the web's
 *  hosted settings do with lucide; a name with no stroke twin keeps its
 *  FontAwesome glyph. */
const STROKE: Partial<Record<IconName, React.ComponentProps<typeof Feather>['name']>> = {
  tachometer: 'pie-chart',
  'envelope-o': 'mail',
  'bell-o': 'bell',
  adjust: 'sun',
  lock: 'lock',
  'info-circle': 'info',
  users: 'users',
  key: 'key',
  laptop: 'monitor',
  trash: 'trash-2',
  'chevron-right': 'chevron-right',
  clipboard: 'clipboard',
  'exclamation-triangle': 'alert-triangle',
  refresh: 'refresh-cw',
  'share-square-o': 'share',
};

function RowIcon({ name, size, color }: { name: IconName; size: number; color: string }) {
  const stroke = useActiveLook() === 'family' ? STROKE[name] : undefined;
  return stroke ? <Feather name={stroke} size={size + 1} color={color} /> : <FontAwesome name={name} size={size} color={color} />;
}

/** The page every settings screen scrolls in: keyboard-aware for the profile
 *  editors, padded so cards sit off the edges. */
export function SettingsScroll({ children }: { children: ReactNode }) {
  useTheme();
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A titled card of rows, hairline dividers between them. Falsy children are
 *  skipped, so a conditional row never leaves a stray divider. */
export function SettingsGroup({ title, footnote, children }: { title?: string; footnote?: string; children: ReactNode }) {
  useTheme();
  const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return (
    <RNView style={styles.section}>
      {title ? <RNText style={styles.sectionTitle}>{title}</RNText> : null}
      <RNView style={styles.card}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <RNView style={styles.divider} />}
            {row}
          </Fragment>
        ))}
      </RNView>
      {footnote ? <RNText style={styles.footnote}>{footnote}</RNText> : null}
    </RNView>
  );
}

export function ToggleRow({ label, description, value, onValueChange }: {
  label: string; description?: string; value: boolean; onValueChange: (v: boolean) => void;
}) {
  useTheme();
  return (
    <RNView style={styles.row}>
      <RNView style={styles.rowText}>
        <RNText style={styles.label}>{label}</RNText>
        {description ? <RNText style={styles.description}>{description}</RNText> : null}
      </RNView>
      <SettingsSwitch value={value} onValueChange={onValueChange} />
    </RNView>
  );
}

export function SettingsSwitch({ value, onValueChange }: { value: boolean; onValueChange: (v: boolean) => void }) {
  const Theme = useTheme();
  // The family look spends its accent on what waits on the person, so an
  // "on" reads in the family's ok green.
  const on = useActiveLook() === 'family' ? Theme.green : Theme.accent;
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: Theme.bgHighlight, true: on }}
      thumbColor="#fff"
      ios_backgroundColor={Theme.bgHighlight}
    />
  );
}

/** A tappable row: a leading icon, a label, an optional value on the right,
 *  and a chevron (or a trailing icon for an in-place action). */
export function NavRow({ icon, iconColor, label, description, detail, trailingIcon, onPress, tone }: {
  icon?: IconName; iconColor?: string; label: string; description?: string; detail?: ReactNode;
  trailingIcon?: IconName; onPress: () => void; tone?: 'danger';
}) {
  const Theme = useTheme();
  const labelColor = tone === 'danger' ? Theme.red : Theme.text;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={label}>
      {icon ? (
        <RNView style={styles.iconSlot}>
          <RowIcon name={icon} size={15} color={iconColor ?? (tone === 'danger' ? Theme.red : Theme.textMuted)} />
        </RNView>
      ) : null}
      <RNView style={styles.rowText}>
        <RNText style={[styles.label, { color: labelColor }]}>{label}</RNText>
        {description ? <RNText style={styles.description}>{description}</RNText> : null}
      </RNView>
      <RNView style={styles.trailing}>
        {typeof detail === 'string' ? <RNText style={styles.detail} numberOfLines={1}>{detail}</RNText> : detail}
        <RowIcon name={trailingIcon ?? 'chevron-right'} size={trailingIcon ? 15 : 10} color={trailingIcon ? Theme.textMuted : Theme.textMuted0} />
      </RNView>
    </TouchableOpacity>
  );
}

export const settingsStyles = themedStyles((Theme, look) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xxxl,
  },
  section: {
    marginTop: Spacing.xl,
  },
  // Group labels read in sentence case in the family look, as the web's
  // hosted group labels do.
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    textTransform: look === 'family' ? 'none' : 'uppercase',
    letterSpacing: look === 'family' ? 0 : 0.5,
    marginBottom: Spacing.sm,
    marginLeft: Spacing.xs,
  },
  card: {
    backgroundColor: Theme.bgAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: 'hidden',
  },
  footnote: {
    fontSize: 12,
    color: Theme.textMuted0,
    marginTop: Spacing.sm,
    marginHorizontal: Spacing.xs,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    minHeight: 50,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
    marginLeft: Spacing.lg,
  },
  iconSlot: {
    width: 22,
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  rowText: {
    flex: 1,
    marginRight: Spacing.md,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    color: Theme.text,
  },
  description: {
    fontSize: 13,
    color: Theme.textMuted,
    marginTop: 2,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  detail: {
    fontSize: 15,
    color: Theme.textMuted,
    flexShrink: 1,
  },
  muted: {
    fontSize: 14,
    color: Theme.textMuted0,
    fontStyle: 'italic',
  },
}));

const styles = settingsStyles;
