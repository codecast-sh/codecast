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
import { forwardRef } from 'react';

import { Theme } from '@/constants/Theme';
import { monoStyle } from '@/constants/fonts';

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
  // The app currently pins Solarized Light (dark parity is a follow-up); the
  // light/dark prop API is kept so call sites stay source-compatible.
  return props.light ?? (colorName === 'text' ? Theme.text : Theme.bg);
}

export const Text = forwardRef<DefaultText, TextProps>(function Text(props, ref) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  return <DefaultText ref={ref} {...otherProps} style={monoStyle([{ color }, style])} />;
});

export const TextInput = forwardRef<DefaultTextInput, TextInputProps>(function TextInput(props, ref) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  return (
    <DefaultTextInput
      ref={ref}
      placeholderTextColor={Theme.inputPlaceholder}
      {...otherProps}
      style={monoStyle([{ color }, style])}
    />
  );
});

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
