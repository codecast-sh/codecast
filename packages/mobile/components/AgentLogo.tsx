import { View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import Svg, { Path } from 'react-native-svg';
import { Theme } from '@/constants/Theme';

export function agentLogoBg(agentType?: string): string {
  if (agentType === 'codex') return '#0f0f0f';
  if (agentType === 'cursor') return '#1a1a2e';
  if (agentType === 'gemini') return '#1a73e8';
  if (agentType === 'opencode') return '#f97316';
  if (agentType === 'pi') return '#14b8a6';
  if (agentType === 'grok') return Theme.text;
  return '#cb4b16';
}

export function AgentLogoSvg({ agentType, size = 16 }: { agentType?: string; size?: number }) {
  const bg = agentLogoBg(agentType);
  const iconSize = size * 0.6;
  if (agentType === 'opencode') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M8 6l-5 6 5 6" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M16 6l5 6-5 6" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'pi') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: size * 0.2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <RNText style={{ color: 'white', fontSize: size * 0.6, fontWeight: '700', lineHeight: size * 0.85, textAlign: 'center' }}>π</RNText>
      </RNView>
    );
  }
  if (agentType === 'grok') {
    // Official Grok logomark — same paths as web's GrokIcon.
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0.36 0.5 33.33 32">
          <Path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436" fill="white" />
          <Path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341" fill="white" />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'codex') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729z" fill="white" />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'cursor') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M4 4l16 6-8 2-2 8z" stroke="white" strokeWidth={2} />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'gemini') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 28 28">
          <Path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" fill="white" />
        </Svg>
      </RNView>
    );
  }
  // Anthropic wordmark glyph — same path as web's AgentTypeIcon (claude_code).
  return (
    <RNView style={{ width: size, height: size, borderRadius: size * 0.2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size * 0.7} height={size * 0.7} viewBox="0 0 24 24" fill="none">
        <Path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" fill="white" />
      </Svg>
    </RNView>
  );
}
