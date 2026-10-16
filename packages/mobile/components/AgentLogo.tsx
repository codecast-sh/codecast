import { View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Theme, useActiveLook } from '@/constants/Theme';
import { MOBILE_AGENT_LOGO_BG, MUSE_MARK_PATH } from '@codecast/shared/render/mobileSessionStyle';
import { CODECAST_MARK_ARROW_PATH, CODECAST_MARK_C_PATH, CODECAST_MARK_VIEWBOX } from '@codecast/shared/render/codecastMark';
import { isHostedAgentType } from '@codecast/shared/contracts';

export function agentLogoBg(agentType?: string): string {
  const bg = agentType ? MOBILE_AGENT_LOGO_BG[agentType] : undefined;
  if (bg) return bg;
  if (agentType === 'grok') return Theme.text;
  // The hosted Codecast assistant wears codecast's cyan, as on the web.
  if (isHostedAgentType(agentType)) return Theme.cyan;
  return '#cb4b16';
}

export function AgentLogoSvg({ agentType, size = 16 }: { agentType?: string; size?: number }) {
  const bg = agentLogoBg(agentType);
  const family = useActiveLook() === 'family';
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
  if (isHostedAgentType(agentType)) {
    // The codecast mark, tight-cropped, in white on the assistant's cyan. In
    // the family look it is the web's AssistantMark: the glyph knocked out of
    // a solid ink disc, the one mark the hosted assistant wears everywhere.
    return (
      <RNView style={{ width: size, height: size, borderRadius: family ? size / 2 : size * 0.2, backgroundColor: family ? Theme.text : bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size * (family ? 0.56 : 0.72)} height={size * (family ? 0.56 : 0.72)} viewBox={CODECAST_MARK_VIEWBOX}>
          <Path d={CODECAST_MARK_C_PATH} fill={family ? Theme.bg : 'white'} />
          <Path d={CODECAST_MARK_ARROW_PATH} fill={family ? Theme.bg : 'white'} />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'muse') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size * 0.7} height={size * 0.7} viewBox="0 0 24 24">
          <Path d={MUSE_MARK_PATH} fill="white" fillRule="evenodd" />
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

const CODEX_MARK_PATH = 'm84.3 5.1q3.7-1.5 7.7-2.6 3.9-1 7.9-1.6 4-0.5 8.1-0.6 4 0 8 0.5 20.7 2.4 37.1 17.7 0.1 0.1 0.4 0.3 0.1 0 0.2 0 0 0 0.2 0 0 0 0.1 0 0 0 0.1 0 5.2-1.4 10.7-1.9 5.4-0.4 10.7 0.1 5.5 0.4 10.7 1.9 5.2 1.3 10.1 3.6l0.6 0.4 1.6 0.8q5.2 2.5 9.7 6.1 4.7 3.4 8.6 7.7 3.8 4.3 6.9 9.2 3 4.8 5.2 10.2 4.3 10.5 4.3 22.1 0.2 2.1 0 4.2-0.1 2.2-0.2 4.3-0.3 2.1-0.7 4.3-0.4 2.1-0.9 4.1 0 0.2 0 0.4 0 0.2 0 0.5 0 0.1 0.1 0.4 0.1 0.1 0.3 0.3 12.3 12.6 16.3 30 6 29.7-12.2 53.5l-1.9 2.2q-3 3.5-6.5 6.4-3.4 3.1-7.3 5.5-3.8 2.4-8.1 4.2-4.1 1.9-8.5 3.2-0.3 0-0.4 0.2-0.3 0-0.4 0.1-0.1 0.1-0.3 0.4 0 0.1-0.1 0.3c-2.7 7.7-5.3 14.2-10.2 20.7-12.5 16.5-30.8 25.5-51.5 25.5q-24.6-0.1-43.6-18.1-0.2-0.1-0.4-0.2-0.2-0.1-0.4-0.1-0.2 0-0.3 0-0.3 0-0.4 0c-5.4 1.7-10.9 1.9-16.7 1.9q-3.5 0-7-0.5-3.4-0.4-6.9-1.2-3.3-0.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-0.8-1.6-1.6-3.2-0.6-1.7-1.3-3.3-0.7-1.7-1.2-3.4-0.5-1.6-1-3.4-1.1-4-1.6-7.9-0.6-4-0.6-8 0-4 0.6-8 0.4-4 1.4-8 0 0 0-0.1 0-0.1 0-0.1 0.2-0.2 0.2-0.3 0-0.1-0.2-0.1 0-0.2 0-0.3 0-0.1-0.1-0.1 0-0.2 0-0.2-0.1-0.1-0.1-0.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-0.8-2-1.3-4.1-0.7-2-1.1-4-0.4-2.1-0.7-4.2-0.2-2.2-0.4-4.3-0.2-2.8-0.1-5.6 0-2.8 0.3-5.4 0.1-2.8 0.6-5.6 0.4-2.8 1.1-5.5 7-23.1 26.9-36.3 4.3-2.9 8.2-4.5 4.5-1.9 9-3.2 0.2 0 0.3-0.1 0.1-0.2 0.3-0.3 0.1 0 0.1-0.3 0.1-0.1 0.1-0.2 1-3.1 2.2-6 1-2.9 2.5-5.7 1.5-3 3.2-5.6 1.7-2.7 3.7-5.1 2.5-3.2 5.3-5.9 3-2.8 6.1-5.4 3.2-2.4 6.8-4.4 3.5-2 7.2-3.5zm48.3 146.4c-2.3 0.1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3 0.9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4 0.1 4.8-0.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-0.5-4.5-0.3-6.5 0.9-2 1.1-3.5 3-4.1 5.2-0.7 2.2-0.4 4.6 0.6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8 0.7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7 0.9 2.2-0.5 4.2-1.9 5.4-3.9l20.1-34.1q0.7-0.9 0.9-2.1 0.3-1.1 0.3-2.3 0-1.2-0.3-2.2-0.2-1.2-0.8-2.2z';

/** An agent's bare mark in its own color, as web's AgentTypeIcon draws it:
 *  no tile behind it. AgentLogoSvg is the tiled avatar for rows and headers. */
export function AgentGlyph({ agentType, size = 16 }: { agentType?: string; size?: number }) {
  if (agentType === 'codex' || agentType === 'codex_cli') {
    return (
      <Svg width={size} height={size} viewBox="0 0 250 250">
        <Defs>
          <LinearGradient id="codexMark" x1="0" y1="0.33" x2="0" y2="249.67" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#b1a7ff" />
            <Stop offset="0.5" stopColor="#7a9dff" />
            <Stop offset="1" stopColor="#3941ff" />
          </LinearGradient>
        </Defs>
        <Path d={CODEX_MARK_PATH} fill="url(#codexMark)" />
      </Svg>
    );
  }
  if (agentType === 'cursor') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M4 4l16 6-8 2-2 8z" stroke="#60a5fa" strokeWidth={2} />
      </Svg>
    );
  }
  if (agentType === 'gemini') {
    return (
      <Svg width={size} height={size} viewBox="0 0 28 28">
        <Path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" fill="#60a5fa" />
      </Svg>
    );
  }
  if (agentType === 'opencode') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M8 6l-5 6 5 6M16 6l5 6-5 6" stroke="#fb923c" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (agentType === 'pi') {
    return (
      <RNView style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <RNText style={{ color: '#2dd4bf', fontSize: size, fontWeight: '600', lineHeight: size * 1.15 }}>π</RNText>
      </RNView>
    );
  }
  if (agentType === 'grok') {
    return (
      <Svg width={size} height={size} viewBox="0.36 0.5 33.33 32">
        <Path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436" fill={Theme.text} />
        <Path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341" fill={Theme.text} />
      </Svg>
    );
  }
  if (agentType === 'muse') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={MUSE_MARK_PATH} fill="#3b82f6" fillRule="evenodd" />
      </Svg>
    );
  }
  if (isHostedAgentType(agentType)) {
    // Web's AssistantMark: the codecast mark knocked out of an ink disc.
    return (
      <RNView style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: Theme.text, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size * 0.64} height={size * 0.64} viewBox={CODECAST_MARK_VIEWBOX}>
          <Path d={CODECAST_MARK_C_PATH} fill={Theme.bg} />
          <Path d={CODECAST_MARK_ARROW_PATH} fill={Theme.bg} />
        </Svg>
      </RNView>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" fill="#fbbf24" />
    </Svg>
  );
}
