import { useColorScheme as useRNColorScheme } from 'react-native';
import { useInboxStore } from '@codecast/web/store/inboxStore';

export function useColorScheme(): 'light' | 'dark' {
  const storeTheme = useInboxStore((s) => s.clientState?.ui?.theme);
  const systemScheme = useRNColorScheme();
  if (storeTheme === 'light' || storeTheme === 'dark') return storeTheme;
  return systemScheme ?? 'light';
}
