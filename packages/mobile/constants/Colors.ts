import { SolarizedDark, SolarizedLight } from './Theme';

// Solarized-backed palette for the few legacy call sites that still read
// Colors.light/dark. New code should import Theme from '@/constants/Theme'.
export default {
  light: {
    text: SolarizedLight.text,
    background: SolarizedLight.bg,
    tint: SolarizedLight.blue,
    tabIconDefault: SolarizedLight.tabInactive,
    tabIconSelected: SolarizedLight.tabActive,
  },
  dark: {
    text: SolarizedDark.text,
    background: SolarizedDark.bg,
    tint: SolarizedDark.blue,
    tabIconDefault: SolarizedDark.tabInactive,
    tabIconSelected: SolarizedDark.tabActive,
  },
};
