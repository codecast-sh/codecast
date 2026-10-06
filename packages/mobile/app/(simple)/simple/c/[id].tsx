// One conversation in the assistant lane on the phone (on the web, the main
// conversation page in hosted mode): the transcript with its steps folded, any
// approval it is waiting on with the actual draft, and the reply box resting
// on the bottom edge. It opens above the lane's tabs, without the tab bar.
import { useRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { useAckActiveSession } from '@/hooks/useAckActiveSession';
import { isConvexId, useInboxStore } from '@codecast/web/store/inboxStore';
import { LANE_COPY, LANE_PATHS, conversationTitle } from '@codecast/web/components/simple/lane';
import { useLaneConversation } from '@codecast/web/components/simple/useLane';
import { ApprovalCard } from '@/components/simple/ApprovalCard';
import { Composer } from '@/components/simple/Composer';
import { Transcript } from '@/components/simple/Transcript';
import { LaneButton, LanePaper, WorkingDots } from '@/components/simple/LaneUI';
import { LANE_READ_FACES, useLaneTheme } from '@/components/simple/laneTheme';

const NEAR_BOTTOM_PX = 220;
const WORDS = LANE_COPY.conversation;

export default function SimpleConversation() {
  const { c } = useLaneTheme();
  const insets = useSafeAreaInsets();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  // The stub's real id arrived: the address follows it, so the screen a
  // notification or a link names is the real conversation.
  const { liveId, approvals, working, loading, items, hasMoreAbove, isLoadingOlder, loadOlder, send: sendText, retry } = useLaneConversation(
    id,
    (realId) => router.setParams({ id: realId }),
  );
  const title = useInboxStore((s) => conversationTitle((s.sessions[liveId] ?? s.conversations[liveId]) as any));
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
    <LanePaper>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 6, backgroundColor: c.paper }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={LANE_COPY.conversation.back}
            hitSlop={8}
            onPress={() => (router.canGoBack() ? router.back() : router.replace(LANE_PATHS.home as never))}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.hover : 'transparent' })}
          >
            <Feather name="arrow-left" size={21} color={c.soft} />
          </Pressable>
          <Text numberOfLines={1} accessibilityRole="header" style={{ flex: 1, fontFamily: LANE_READ_FACES.semiBold, fontSize: 18.5, color: c.ink }}>
            {title}
          </Text>
        </View>
        <ScrollView
          ref={scroller}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 18, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={onContentSizeChange}
        >
          {hasMoreAbove ? (
            <LaneButton small tone="no" label={isLoadingOlder ? WORDS.loadingEarlier : WORDS.earlier} disabled={isLoadingOlder} onPress={() => loadOlder()} style={{ alignSelf: 'center' }} />
          ) : null}
          {loading ? <Text accessibilityRole="text" style={{ fontSize: 14.5, color: c.soft }}>{WORDS.loading}</Text> : null}
          <Transcript items={items} onRetry={retry} />
          {approvals.map((d, n) => <ApprovalCard key={d._id} decision={d} index={n} here />)}
          {working && approvals.length === 0 ? (
            <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <WorkingDots />
              <Text style={{ fontSize: 14.5, color: c.soft }}>{WORDS.working}</Text>
            </View>
          ) : null}
        </ScrollView>
        <View style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: c.paper }}>
          <Composer placeholder={approvals.length ? WORDS.change : WORDS.reply} onSend={send} />
        </View>
      </KeyboardAvoidingView>
    </LanePaper>
  );
}

