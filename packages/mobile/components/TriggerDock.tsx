import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { taskDisplayTitle, isTriggerFailing, type TriggerRow, type TaskRow } from '@codecast/web/components/triggerTasks';
import { describeTaskCadence, fmtClock, fmtDuration, taskStateLabel } from '@codecast/web/components/triggerCadence';

// The mobile TRIGGERS dock — the phone twin of GlobalSessionPanel's TriggerDock.
// Every armed schedule lives in this one collapsible line docked at the top of
// the inbox footer; the sessions those schedules quietly drive are absorbed
// behind it (see partitionTriggerInbox). Collapsed, the line is the briefing:
// how many are armed, when the next fires, how many outcomes landed unread, and
// a red tint when one failed. Expanded, one row per schedule opens the
// conversation behind it. CLOSING stamps the read watermark (schedules_seen_at)
// — while open the per-row "new" pills stay visible, matching desktop.

// Cadence chip text: recurring/event read off the task fields ("every 7d",
// "on PR comment"); a one-time schedule shows WHEN it fires instead of the
// generic "one-time".
function cadenceLabel(task: TaskRow): string {
  if (task.schedule_type === 'once') return task.run_at ? fmtClock(task.run_at) : 'one-time';
  return describeTaskCadence(task);
}

export function TriggerDock({ rows, unreadCount, nextRunAt }: {
  rows: TriggerRow[];
  unreadCount: number;
  nextRunAt?: number;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const now = useCoarseNow(30_000);

  // Stamp the briefing read on COLLAPSE, not open: the per-row "new" pills are
  // derived from schedules_seen_at, so stamping on open would erase them the
  // moment the roster appeared. Opening leaves the watermark alone.
  const toggle = useCallback(() => {
    setExpanded((prev) => {
      if (prev) useInboxStore.getState().updateClientUI({ schedules_seen_at: Date.now() });
      return !prev;
    });
  }, []);

  if (rows.length === 0) return null;

  const failing = rows.some((r) => isTriggerFailing(r.task));
  const titleColor = failing ? Theme.red : Theme.orange;
  const nextIn = nextRunAt !== undefined ? Math.max(0, nextRunAt - now) : undefined;

  return (
    <RNView style={styles.dock}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.7}>
        <FontAwesome name={expanded ? 'chevron-up' : 'chevron-down'} size={11} color={Theme.textMuted0} />
        <FontAwesome name="clock-o" size={12} color={titleColor} style={{ marginLeft: 2 }} />
        <RNText style={[styles.headerTitle, { color: titleColor }]}>
          Triggers ({rows.length})
        </RNText>
        {nextIn !== undefined && (
          <RNText style={styles.headerNext} numberOfLines={1}>
            next {nextIn > 0 ? `in ${fmtDuration(nextIn)}` : 'due'}
          </RNText>
        )}
        <RNView style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <RNView style={styles.newPill}>
            <RNText style={styles.newPillText}>{unreadCount} new</RNText>
          </RNView>
        )}
      </TouchableOpacity>

      {expanded && (
        <RNView style={styles.rows}>
          {rows.map((row) => {
            const { task } = row;
            const countdown =
              task.status === 'scheduled' && task.run_at !== undefined ? taskStateLabel(task, now) : null;
            return (
              <TouchableOpacity
                key={task._id}
                style={styles.row}
                activeOpacity={row.openId ? 0.6 : 1}
                onPress={() => {
                  if (row.openId) router.push(`/session/${row.openId}`);
                }}
              >
                <RNView style={styles.rowMain}>
                  {isTriggerFailing(task) && <RNView style={styles.failDot} />}
                  <RNText style={styles.rowTitle} numberOfLines={1}>
                    {taskDisplayTitle(task)}
                  </RNText>
                  {row.unread && (
                    <RNView style={styles.rowNewPill}>
                      <RNText style={styles.rowNewPillText}>new</RNText>
                    </RNView>
                  )}
                </RNView>
                <RNView style={styles.rowMeta}>
                  <RNView style={styles.cadenceChip}>
                    <RNText style={styles.cadenceChipText} numberOfLines={1}>{cadenceLabel(task)}</RNText>
                  </RNView>
                  {countdown && <RNText style={styles.rowCountdown}>{countdown}</RNText>}
                </RNView>
              </TouchableOpacity>
            );
          })}
        </RNView>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  dock: {
    borderTopWidth: 1,
    borderTopColor: Theme.bgHighlight,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  headerNext: {
    fontSize: 12,
    color: Theme.textMuted0,
    flexShrink: 1,
  },
  newPill: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 9,
    backgroundColor: Theme.orange,
  },
  newPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: Theme.bg,
  },
  rows: {
    backgroundColor: Theme.bgAlt,
  },
  row: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  failDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.red,
  },
  rowTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: Theme.text,
  },
  rowNewPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: Theme.orange + '22',
  },
  rowNewPillText: {
    fontSize: 9,
    fontWeight: '700',
    color: Theme.orange,
    textTransform: 'uppercase',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 3,
  },
  cadenceChip: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: Theme.bgHighlight,
    maxWidth: 160,
  },
  cadenceChipText: {
    fontSize: 11,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  rowCountdown: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontWeight: '500',
  },
});
