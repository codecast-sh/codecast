/**
 * App-wide Text / TextInput / View.
 *
 * React Native has no global font inheritance and React 19 removed the
 * Text.defaultProps escape hatch, so these wrappers are the single place the
 * JetBrains Mono default is enforced (see constants/fonts.ts). Import Text
 * from here, never from 'react-native' — that is what keeps mobile typography
 * in lockstep with web, where every surface renders in JetBrains Mono.
 */

import {
  Text as DefaultText,
  TextInput as DefaultTextInput,
  View as DefaultView,
} from 'react-native';
import { createContext, forwardRef, useContext } from 'react';

import { Theme, useActiveLook, useActiveScheme, useTheme } from '@/constants/Theme';
import { monoStyle, namedFaceGroup, useLateFacesLoaded, type FaceGroup } from '@/constants/fonts';

// The face group a Text names outright, handed to the Text nested in it: RN
// nests Text the way the DOM nests spans, and a span that names no family
// keeps its parent's (a bold run inside a reply set in the reading face).
const InheritedFace = createContext<FaceGroup | undefined>(undefined);

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];
export type TextInputProps = ThemeProps & React.ComponentProps<typeof DefaultTextInput>;

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: 'text' | 'background'
) {
  // Subscribes the wrapper to scheme flips; Theme itself reads live.
  const scheme = useActiveScheme();
  return props[scheme] ?? (colorName === 'text' ? Theme.text : Theme.bg);
}

export const Text = forwardRef<DefaultText, TextProps>(function Text(props, ref) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  const late = useLateFacesLoaded();
  const inherited = useContext(InheritedFace);
  const text = <DefaultText ref={ref} {...otherProps} style={monoStyle([{ color }, style], late, undefined, inherited)} />;
  const named = namedFaceGroup(style);
  return named && named !== inherited ? <InheritedFace.Provider value={named}>{text}</InheritedFace.Provider> : text;
});

export const TextInput = forwardRef<DefaultTextInput, TextInputProps>(function TextInput(props, ref) {
  const Theme = useTheme();
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  const late = useLateFacesLoaded();
  // The family look's caret is ink, as on the web, not the system blue.
  const family = useActiveLook() === 'family';
  return (
    <DefaultTextInput
      ref={ref}
      placeholderTextColor={Theme.inputPlaceholder}
      selectionColor={family ? Theme.text : undefined}
      {...otherProps}
      style={monoStyle([{ color }, style], late)}
    />
  );
});

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
