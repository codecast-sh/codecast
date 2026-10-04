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
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

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
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
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
          <FontAwesome name={icon} size={15} color={iconColor ?? (tone === 'danger' ? Theme.red : Theme.textMuted)} />
        </RNView>
      ) : null}
      <RNView style={styles.rowText}>
        <RNText style={[styles.label, { color: labelColor }]}>{label}</RNText>
        {description ? <RNText style={styles.description}>{description}</RNText> : null}
      </RNView>
      <RNView style={styles.trailing}>
        {typeof detail === 'string' ? <RNText style={styles.detail} numberOfLines={1}>{detail}</RNText> : detail}
        <FontAwesome name={trailingIcon ?? 'chevron-right'} size={trailingIcon ? 15 : 10} color={trailingIcon ? Theme.textMuted : Theme.textMuted0} />
      </RNView>
    </TouchableOpacity>
  );
}

export const settingsStyles = themedStyles((Theme) => StyleSheet.create({
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
