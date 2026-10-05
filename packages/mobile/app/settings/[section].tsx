import { Stack, useLocalSearchParams } from 'expo-router';
import { SETTINGS_PAGES } from '@/components/settings/SettingsPages';

// One route for every settings sub-screen; the Settings tab links here by key.
export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const entry = SETTINGS_PAGES[section ?? ''];
  if (!entry) return <Stack.Screen options={{ title: 'Settings' }} />;
  const { title, Page } = entry;
  return (
    <>
      <Stack.Screen options={{ title, headerBackTitle: 'Settings' }} />
      <Page />
    </>
  );
}
