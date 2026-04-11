import { useEffect, useRef } from 'react';
import { StyleSheet, Animated, View as RNView } from 'react-native';
import { Theme, Spacing } from '@/constants/Theme';

function SkeletonPulse({ style }: { style?: any }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return <Animated.View style={[styles.bone, style, { opacity }]} />;
}

export function SessionSkeleton() {
  return (
    <RNView style={styles.sessionRow}>
      <RNView style={styles.sessionLeft}>
        <SkeletonPulse style={styles.dot} />
        <SkeletonPulse style={styles.titleBar} />
      </RNView>
      <SkeletonPulse style={styles.countBadge} />
    </RNView>
  );
}

export function SessionListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <RNView style={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <SessionSkeleton key={i} />
      ))}
    </RNView>
  );
}

export function MemberSkeleton() {
  return (
    <RNView style={styles.memberRow}>
      <SkeletonPulse style={styles.avatar} />
      <RNView style={styles.memberInfo}>
        <SkeletonPulse style={styles.nameBar} />
        <SkeletonPulse style={styles.emailBar} />
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
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
});
