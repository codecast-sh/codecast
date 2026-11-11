/**
 * App-wide Text / TextInput / View.
 *
 * React Native has no global font inheritance and React 19 removed the
 * Text.defaultProps escape hatch, so these wrappers are the single place the
 * JetBrains Mono default is enforced (see constants/fonts.ts). Import Text
 * from here, never from 'react-native' — that is what keeps mobile typography
 * in lockstep with web, where every surface renders in JetBrains Mono in
 * Classic and in Instrument Sans under Modern.
 */

import {
  Text as DefaultText,
  TextInput as DefaultTextInput,
  View as DefaultView,
} from 'react-native';
import { createContext, forwardRef, useContext } from 'react';

import { Theme, getActiveLook, useActiveScheme, useTheme } from '@/constants/Theme';
import { isCapsText, monoStyle, namedFaceGroup, useLateFacesLoaded, type FaceGroup } from '@/constants/fonts';

// Under Modern, the face group a Text names outright, handed to the Text
// nested in it: RN nests Text the way the DOM nests spans, and a span that
// names no family keeps its parent's (a bold run inside mono code stays mono).
// Classic never provides it: every unnamed Text is mono there already.
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
  // useThemeColor's subscription is to look and scheme together, so this
  // render already follows a look flip; no second subscription per Text.
  const look = getActiveLook();
  const inherited = useContext(InheritedFace);
  if (look !== 'modern') return <DefaultText ref={ref} {...otherProps} style={monoStyle([{ color }, style], late, look)} />;
  const text = <DefaultText ref={ref} {...otherProps} style={monoStyle([{ color }, style], late, look, inherited, isCapsText(otherProps.children))} />;
  const named = namedFaceGroup(style);
  return named && named !== inherited ? <InheritedFace.Provider value={named}>{text}</InheritedFace.Provider> : text;
});

export const TextInput = forwardRef<DefaultTextInput, TextInputProps>(function TextInput(props, ref) {
  const Theme = useTheme();
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  const late = useLateFacesLoaded();
  const look = getActiveLook();
  return (
    <DefaultTextInput
      ref={ref}
      placeholderTextColor={Theme.inputPlaceholder}
      {...otherProps}
      style={monoStyle([{ color }, style], late, look)}
    />
  );
});

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
