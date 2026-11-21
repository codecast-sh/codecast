import { Image, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { authorToneName, type NavigatorAuthor } from '@codecast/web/lib/messageNavigator';

/** A person's color in a thread (the shared tone order), or undefined for the
 *  unmarked voice. Their rail ticks and face both wear it. */
export function useAuthorToneColor(): (tone: number) => string | undefined {
  const Theme = useTheme();
  return (tone) => {
    const name = authorToneName(tone);
    return name ? Theme[name] : undefined;
  };
}

/** A sender's face, square like the web navigator's; their initial on their
 *  color when they have no picture. */
export function AuthorFace({ author, size }: { author: NavigatorAuthor; size: number }) {
  const Theme = useTheme();
  const toneColor = useAuthorToneColor();
  if (author.image) {
    return <Image source={{ uri: author.image }} style={[styles.face, { width: size, height: size }]} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[styles.face, styles.initialBox, { width: size, height: size, backgroundColor: toneColor(author.tone) ?? Theme.blue }]}>
      <Text style={[styles.initial, { fontSize: Math.round(size * 0.6), color: Theme.bg }]} maxFontSizeMultiplier={1}>
        {author.name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  face: { borderRadius: 3 },
  initialBox: { alignItems: 'center', justifyContent: 'center' },
  initial: { fontWeight: '700', textAlign: 'center', includeFontPadding: false, textAlignVertical: 'center' },
});
