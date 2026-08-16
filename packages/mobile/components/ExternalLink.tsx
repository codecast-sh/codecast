import { Link } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';
import { openLink } from '@/lib/links';

export function ExternalLink(
  props: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: string }
) {
  return (
    <Link
      target="_blank"
      {...props}
      // @ts-expect-error: External URLs are not typed.
      href={props.href}
      onPress={(e) => {
        if (Platform.OS !== 'web') {
          // One link policy for the whole app (lib/links): codecast objects
          // route in-app, everything else opens the in-app browser.
          e.preventDefault();
          void openLink(props.href);
        }
      }}
    />
  );
}
