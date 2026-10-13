import { useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, Animated, AccessibilityInfo, View as RNView } from 'react-native';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';

// One breathing opacity for a whole skeleton, so its bones pulse together
// instead of each running its own loop.
function Pulse({ children, style }: { children: ReactNode; style?: any }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => { if (live && !reduce) animation.start(); });
    return () => { live = false; animation.stop(); };
  }, [opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}

function Bone({ style }: { style?: any }) {
  return <RNView style={[styles.bone, style]} />;
}

export function SessionSkeleton() {
  useTheme();
  return (
    <RNView style={styles.sessionRow}>
      <RNView style={styles.sessionLeft}>
        <Bone style={styles.dot} />
        <Bone style={styles.titleBar} />
      </RNView>
      <Bone style={styles.countBadge} />
    </RNView>
  );
}

export function SessionListSkeleton({ count = 8 }: { count?: number }) {
  useTheme();
  return (
    <Pulse style={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <SessionSkeleton key={i} />
      ))}
    </Pulse>
  );
}

export function NotificationSkeleton() {
  useTheme();
  return (
    <RNView style={styles.notificationRow}>
      <Bone style={styles.notificationAvatar} />
      <RNView style={styles.notificationBody}>
        <Bone style={styles.notificationName} />
        <Bone style={styles.notificationContext} />
        <Bone style={styles.notificationMessage} />
      </RNView>
    </RNView>
  );
}

export function NotificationListSkeleton({ count = 8 }: { count?: number }) {
  useTheme();
  return (
    <Pulse style={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <NotificationSkeleton key={i} />
      ))}
    </Pulse>
  );
}

export function MemberSkeleton() {
  useTheme();
  return (
    <Pulse style={styles.memberRow}>
      <Bone style={styles.avatar} />
      <RNView style={styles.memberInfo}>
        <Bone style={styles.nameBar} />
        <Bone style={styles.emailBar} />
      </RNView>
    </Pulse>
  );
}

// A conversation's first paint: a few messages, each a face, a name and two
// lines of text.
export function ConversationSkeleton({ count = 3 }: { count?: number }) {
  useTheme();
  return (
    <Pulse style={styles.conversation}>
      {Array.from({ length: count }).map((_, i) => (
        <RNView key={i} style={styles.messageRow}>
          <Bone style={styles.messageAvatar} />
          <RNView style={styles.messageBody}>
            <Bone style={styles.messageName} />
            <Bone style={[styles.messageLine, { width: `${88 - i * 14}%` }]} />
            <Bone style={[styles.messageLine, { width: `${56 - i * 8}%` }]} />
          </RNView>
        </RNView>
      ))}
    </Pulse>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: {
    paddingVertical: 4,
  },
  bone: {
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  sessionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  titleBar: {
    width: '70%',
    height: 14,
    borderRadius: 4,
  },
  countBadge: {
    width: 20,
    height: 12,
    borderRadius: 3,
  },
  notificationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  notificationAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    marginRight: Spacing.md,
    marginTop: 2,
  },
  notificationBody: {
    flex: 1,
    gap: 6,
  },
  notificationName: {
    width: '45%',
    height: 14,
    borderRadius: 4,
  },
  notificationContext: {
    width: '60%',
    height: 11,
    borderRadius: 3,
  },
  notificationMessage: {
    width: '85%',
    height: 12,
    borderRadius: 4,
  },
  conversation: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    gap: 22,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  messageAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  messageBody: {
    flex: 1,
    gap: 8,
    paddingTop: 4,
  },
  messageName: {
    width: 84,
    height: 10,
    borderRadius: 4,
  },
  messageLine: {
    height: 10,
    borderRadius: 4,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  memberInfo: {
    flex: 1,
    gap: 6,
  },
  nameBar: {
    width: '50%',
    height: 14,
    borderRadius: 4,
  },
  emailBar: {
    width: '35%',
    height: 11,
    borderRadius: 3,
  },
}));
