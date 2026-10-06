// A conversation with the hosted assistant on the phone, the screen
// /session/<id> shows when the conversation runs on it (app/session/[id]):
// the transcript with its steps in plain words, any approval it waits on
// with the actual draft, and the reply box resting on the bottom edge. No
// machine, model or terminal: nothing here runs on a computer. Its model is
// the web's own (useLaneConversation), so a stub opened at once from the
// new conversation sheet follows its real id when the server has it.
import { useCallback, useRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text } from '@/components/Themed';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { useAckActiveSession } from '@/hooks/useAckActiveSession';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { isConvexId, useInboxStore } from '@codecast/web/store/inboxStore';
import { agentDisplayName } from '@codecast/shared/contracts';
import { HOSTED_AGENT_TYPE } from '@codecast/shared/contracts/assistant';
import { LANE_COPY, conversationTitle } from '@codecast/web/components/simple/lane';
import { useLaneConversation } from '@codecast/web/components/simple/useLane';
import { ApprovalCard } from './ApprovalCard';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { HostedButton, WorkingDots } from './HostedUI';
import { useHostedTheme } from './hostedTheme';

const NEAR_BOTTOM_PX = 220;
const WORDS = LANE_COPY.conversation;

export function HostedConversation({ id }: { id: string }) {
  const Theme = useTheme();
  const { c } = useHostedTheme();
  const insets = useSafeAreaInsets();
  // The stub's real id arrived: the address follows it, so the screen a
  // notification or a link names is the real conversation.
  const { liveId, approvals, working, loading, items, hasMoreAbove, isLoadingOlder, loadOlder, send: sendText, retry } = useLaneConversation(
    id,
    (realId) => router.setParams({ id: realId }),
  );
  const title = useInboxStore((s) => conversationTitle((s.sessions[liveId] ?? s.conversations[liveId]) as any));
  // The focused conversation keeps its unsent bubbles through the liveness
  // reconciler, as the session screen's does; its unread mark clears here.
  useFocusEffect(useCallback(() => { useInboxStore.getState().setCurrentSession(liveId); }, [liveId]));
  useAckActiveSession(isConvexId(liveId) ? liveId : null);

  // Open at the newest line, and follow new lines while the reader is at the bottom.
  const scroller = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  const opened = useRef(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - NEAR_BOTTOM_PX;
  };
  const onContentSizeChange = () => {
    if (!opened.current && items.length > 0) {
      opened.current = true;
      scroller.current?.scrollToEnd({ animated: false });
    } else if (atBottom.current) {
      scroller.current?.scrollToEnd({ animated: true });
    }
  };

  const send = (text: string) => {
    sendText(text);
    atBottom.current = true;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingTop: insets.top + 4,
            paddingHorizontal: 8,
            paddingBottom: 8,
            backgroundColor: Theme.bgAlt,
            borderBottomWidth: 0.5,
            borderBottomColor: Theme.borderLight,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={WORDS.back}
            hitSlop={8}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/inbox' as never))}
            style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.hover : 'transparent' })}
          >
            <FontAwesome name="chevron-left" size={16} color={Theme.text} />
          </Pressable>
          <AgentLogoSvg agentType={HOSTED_AGENT_TYPE} size={22} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} accessibilityRole="header" maxFontSizeMultiplier={CHROME_FONT_CAP} style={{ fontSize: 15, fontWeight: '600', color: Theme.text }}>
              {title}
            </Text>
            <Text numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP} style={{ fontSize: 11.5, color: Theme.textMuted }}>
              {agentDisplayName(HOSTED_AGENT_TYPE)}
            </Text>
          </View>
        </View>
        <ScrollView
          ref={scroller}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={onContentSizeChange}
        >
          {hasMoreAbove ? (
            <HostedButton small tone="no" label={isLoadingOlder ? WORDS.loadingEarlier : WORDS.earlier} disabled={isLoadingOlder} onPress={() => loadOlder()} style={{ alignSelf: 'center' }} />
          ) : null}
          {loading ? <Text accessibilityRole="text" style={{ fontSize: 13.5, color: c.soft }}>{WORDS.loading}</Text> : null}
          <Transcript items={items} onRetry={retry} />
          {approvals.map((d, n) => <ApprovalCard key={d._id} decision={d} index={n} />)}
          {working && approvals.length === 0 ? (
            <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <WorkingDots />
              <Text style={{ fontSize: 13.5, color: c.soft }}>{WORDS.working}</Text>
            </View>
          ) : null}
        </ScrollView>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10), backgroundColor: c.paper }}>
          <Composer placeholder={approvals.length ? WORDS.change : WORDS.reply} onSend={send} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
