import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, ScrollView, TextInput, Alert, View as RNView, Text as RNText } from 'react-native';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';

type ActivityEvent = {
  _id: Id<"team_activity_events">;
  event_type: "session_started" | "session_completed" | "commit_pushed" | "member_joined" | "member_left" | "pr_created" | "pr_merged";
  title: string;
  description?: string;
  timestamp: number;
  related_conversation_id?: Id<"conversations">;
  related_commit_sha?: string;
  related_pr_id?: Id<"pull_requests">;
  metadata?: {
    duration_ms?: number;
    message_count?: number;
    git_branch?: string;
    files_changed?: number;
    insertions?: number;
    deletions?: number;
  };
  actor: {
    _id: Id<"users">;
    name?: string;
    email?: string;
  } | null;
};

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getEventColor(eventType: string): string {
  switch (eventType) {
    case "session_started":
    case "session_completed":
      return Theme.accent;
    case "commit_pushed":
      return Theme.violet;
    case "member_joined":
      return Theme.greenBright;
    case "member_left":
      return Theme.red;
    case "pr_created":
    case "pr_merged":
      return Theme.blue;
    default:
      return Theme.textMuted;
  }
}

function ActivityEventItem({ event, onPress }: { event: ActivityEvent; onPress?: () => void }) {
  const actorName = event.actor?.name || event.actor?.email?.split('@')[0] || "Unknown";
  const eventColor = getEventColor(event.event_type);

  const content = (
    <RNView style={styles.eventCard}>
      <RNView style={[styles.eventIndicator, { backgroundColor: eventColor }]} />
      <RNView style={styles.eventContent}>
        <RNView style={styles.eventHeader}>
          <RNText style={styles.eventTitle} numberOfLines={2}>
            {event.title}
          </RNText>
          <RNText style={styles.eventTime}>
            {formatRelativeTime(event.timestamp)}
          </RNText>
        </RNView>
        <RNView style={styles.eventMeta}>
          <RNText style={styles.metaText}>{actorName}</RNText>
          {event.metadata?.message_count !== undefined && (
            <>
              <RNText style={styles.metaSeparator}>·</RNText>
              <RNText style={styles.metaText}>{event.metadata.message_count} msgs</RNText>
            </>
          )}
        </RNView>
      </RNView>
    </RNView>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

const EVENT_TYPE_FILTERS = [
  { label: "All", value: undefined },
  { label: "Sessions", value: "session_completed" },
  { label: "Commits", value: "commit_pushed" },
  { label: "PRs", value: "pr_created" },
];

function NoTeamView({ userId }: { userId: Id<"users"> }) {
  const [mode, setMode] = useState<"none" | "join" | "create">("none");
  const [inviteCode, setInviteCode] = useState('');
  const [teamName, setTeamName] = useState('');
  const [loading, setLoading] = useState(false);

  const joinTeam = useMutation(api.teams.joinTeam);
  const createTeam = useMutation(api.teams.createTeam);

  const handleJoin = async () => {
    if (!inviteCode.trim()) return;
    setLoading(true);
    try {
      await joinTeam({ invite_code: inviteCode.trim(), user_id: userId });
      Alert.alert('Joined', 'You have joined the team.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to join team');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!teamName.trim()) return;
    setLoading(true);
    try {
      await createTeam({ name: teamName.trim(), user_id: userId });
      Alert.alert('Created', 'Your team has been created.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create team');
    } finally {
      setLoading(false);
    }
  };

  if (mode === "join") {
    return (
      <RNView style={styles.noTeamContainer}>
        <RNText style={styles.noTeamTitle}>Join a Team</RNText>
        <RNText style={styles.noTeamSubtitle}>Enter the invite code from your team admin</RNText>
        <TextInput
          style={styles.noTeamInput}
          value={inviteCode}
          onChangeText={setInviteCode}
          placeholder="Invite code"
          placeholderTextColor={Theme.textMuted0}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <RNView style={styles.noTeamButtons}>
          <TouchableOpacity
            style={[styles.noTeamButton, styles.noTeamButtonPrimary]}
            onPress={handleJoin}
            disabled={loading || !inviteCode.trim()}
            activeOpacity={0.7}
          >
            <RNText style={styles.noTeamButtonPrimaryText}>
              {loading ? 'Joining...' : 'Join'}
            </RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.noTeamButton}
            onPress={() => setMode("none")}
            activeOpacity={0.7}
          >
            <RNText style={styles.noTeamButtonText}>Back</RNText>
          </TouchableOpacity>
        </RNView>
      </RNView>
    );
  }

  if (mode === "create") {
    return (
      <RNView style={styles.noTeamContainer}>
        <RNText style={styles.noTeamTitle}>Create a Team</RNText>
        <RNText style={styles.noTeamSubtitle}>Start a new team and invite your colleagues</RNText>
        <TextInput
          style={styles.noTeamInput}
          value={teamName}
          onChangeText={setTeamName}
          placeholder="Team name"
          placeholderTextColor={Theme.textMuted0}
          autoCapitalize="words"
        />
        <RNView style={styles.noTeamButtons}>
          <TouchableOpacity
            style={[styles.noTeamButton, styles.noTeamButtonPrimary]}
            onPress={handleCreate}
            disabled={loading || !teamName.trim()}
            activeOpacity={0.7}
          >
            <RNText style={styles.noTeamButtonPrimaryText}>
              {loading ? 'Creating...' : 'Create'}
            </RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.noTeamButton}
            onPress={() => setMode("none")}
            activeOpacity={0.7}
          >
            <RNText style={styles.noTeamButtonText}>Back</RNText>
          </TouchableOpacity>
        </RNView>
      </RNView>
    );
  }

  return (
    <RNView style={styles.noTeamContainer}>
      <RNView style={styles.noTeamIcon}>
        <FontAwesome name="users" size={28} color={Theme.textMuted0} />
      </RNView>
      <RNText style={styles.noTeamTitle}>No Team Yet</RNText>
      <RNText style={styles.noTeamSubtitle}>
        Teams let you see what your colleagues are working on and share sessions.
      </RNText>
      <RNView style={styles.noTeamButtons}>
        <TouchableOpacity
          style={[styles.noTeamButton, styles.noTeamButtonPrimary]}
          onPress={() => setMode("join")}
          activeOpacity={0.7}
        >
          <FontAwesome name="sign-in" size={14} color="#fff" style={{ marginRight: 6 }} />
          <RNText style={styles.noTeamButtonPrimaryText}>Join Team</RNText>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.noTeamButton}
          onPress={() => setMode("create")}
          activeOpacity={0.7}
        >
          <FontAwesome name="plus" size={12} color={Theme.text} style={{ marginRight: 6 }} />
          <RNText style={styles.noTeamButtonText}>Create Team</RNText>
        </TouchableOpacity>
      </RNView>
    </RNView>
  );
}

export default function TeamScreen() {
  const [view, setView] = useState<"activity" | "directory">("activity");
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    currentUser?.team_id ? { team_id: currentUser.team_id } : "skip"
  );
  const activityResult = useQuery(
    api.teamActivity.getTeamActivityFeed,
    currentUser?.team_id ? {
      team_id: currentUser.team_id,
      event_type_filter: eventTypeFilter as any,
    } : "skip"
  );

  const events = activityResult?.events || [];

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  const renderActivityItem = ({ item }: { item: ActivityEvent }) => (
    <ActivityEventItem
      event={item}
      onPress={
        item.related_conversation_id
          ? () => router.push(`/session/${item.related_conversation_id}`)
          : undefined
      }
    />
  );

  const renderTeamMemberItem = ({ item }: { item: any }) => {
    const lastSeen = item.daemon_last_seen
      ? formatRelativeTime(item.daemon_last_seen)
      : "Never";
    const isOnline = item.daemon_last_seen && Date.now() - item.daemon_last_seen < 60000;

    return (
      <RNView style={styles.memberCard}>
        <RNView style={styles.memberAvatar}>
          <RNText style={styles.memberAvatarText}>
            {item.name?.[0]?.toUpperCase() || item.email?.[0]?.toUpperCase() || "?"}
          </RNText>
          {isOnline && <RNView style={styles.onlineIndicator} />}
        </RNView>
        <RNView style={styles.memberInfo}>
          <RNText style={styles.memberName}>{item.name || "Unnamed"}</RNText>
          <RNText style={styles.memberEmail}>{item.email}</RNText>
          <RNText style={styles.memberLastSeen}>Last seen {lastSeen}</RNText>
        </RNView>
        {item.role === "admin" && (
          <RNView style={styles.adminBadge}>
            <RNText style={styles.adminBadgeText}>Admin</RNText>
          </RNView>
        )}
      </RNView>
    );
  };

  const renderEmpty = () => (
    <RNView style={styles.emptyContainer}>
      <RNText style={styles.emptyText}>
        {view === "activity"
          ? "No team activity yet.\nActivity will appear as members work."
          : "No team members found."}
      </RNText>
    </RNView>
  );

  if (!currentUser?.team_id) {
    if (!currentUser?._id) return null;
    return (
      <RNView style={styles.container}>
        <NoTeamView userId={currentUser._id} />
      </RNView>
    );
  }

  return (
    <RNView style={styles.container}>
      <RNView style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, view === "activity" && styles.tabActive]}
          onPress={() => setView("activity")}
          activeOpacity={0.7}
        >
          <RNText style={[styles.tabText, view === "activity" && styles.tabTextActive]}>
            Activity
          </RNText>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, view === "directory" && styles.tabActive]}
          onPress={() => setView("directory")}
          activeOpacity={0.7}
        >
          <RNText style={[styles.tabText, view === "directory" && styles.tabTextActive]}>
            Directory
          </RNText>
        </TouchableOpacity>
      </RNView>

      {view === "activity" && (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterContainer}
            contentContainerStyle={styles.filterContent}
          >
            {EVENT_TYPE_FILTERS.map((filter) => (
              <TouchableOpacity
                key={filter.label}
                style={[
                  styles.filterChip,
                  eventTypeFilter === filter.value && styles.filterChipActive,
                ]}
                onPress={() => setEventTypeFilter(filter.value)}
                activeOpacity={0.7}
              >
                <RNText
                  style={[
                    styles.filterChipText,
                    eventTypeFilter === filter.value && styles.filterChipTextActive,
                  ]}
                >
                  {filter.label}
                </RNText>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <FlatList
            data={events}
            renderItem={renderActivityItem}
            keyExtractor={(item) => item._id}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
            }
            ListEmptyComponent={activityResult === undefined ? null : renderEmpty}
            contentContainerStyle={events.length === 0 ? styles.emptyList : styles.listContent}
            showsVerticalScrollIndicator={false}
          />
        </>
      )}

      {view === "directory" && (
        <FlatList
          data={(teamMembers || []).filter(Boolean)}
          renderItem={renderTeamMemberItem}
          keyExtractor={(item) => item!._id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
          }
          ListEmptyComponent={teamMembers === undefined ? null : renderEmpty}
          contentContainerStyle={(teamMembers?.length || 0) === 0 ? styles.emptyList : styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: Theme.text,
  },
  tabText: {
    fontSize: 15,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  tabTextActive: {
    color: Theme.text,
    fontWeight: '600',
  },
  filterContainer: {
    maxHeight: 52,
    backgroundColor: Theme.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: Theme.bgAlt,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  filterChipActive: {
    backgroundColor: Theme.accent,
    borderColor: Theme.accent,
  },
  filterChipText: {
    fontSize: 13,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  filterChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
  },
  eventCard: {
    flexDirection: 'row',
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: 'hidden',
    marginBottom: 10,
  },
  eventIndicator: {
    width: 3,
  },
  eventContent: {
    flex: 1,
    padding: 12,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  eventTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: Theme.text,
    marginRight: 8,
    lineHeight: 19,
  },
  eventTime: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  eventMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 5,
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    marginBottom: 10,
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    position: 'relative',
  },
  memberAvatarText: {
    fontSize: 18,
    fontWeight: '600',
    color: Theme.text,
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Theme.greenBright,
    borderWidth: 2,
    borderColor: Theme.bgAlt,
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    marginBottom: 2,
  },
  memberEmail: {
    fontSize: 13,
    color: Theme.textMuted,
    marginBottom: 2,
  },
  memberLastSeen: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  adminBadge: {
    backgroundColor: Theme.blue,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  adminBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  noTeamContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  noTeamIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  noTeamTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  noTeamSubtitle: {
    fontSize: 15,
    color: Theme.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.xxl,
    maxWidth: 280,
  },
  noTeamInput: {
    width: '100%',
    maxWidth: 280,
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    fontSize: 16,
    color: Theme.text,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    marginBottom: Spacing.lg,
    textAlign: 'center',
  },
  noTeamButtons: {
    gap: 10,
    width: '100%',
    maxWidth: 280,
  },
  noTeamButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: Theme.bgAlt,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  noTeamButtonPrimary: {
    backgroundColor: Theme.accent,
    borderColor: Theme.accent,
  },
  noTeamButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Theme.text,
  },
  noTeamButtonPrimaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 15,
    color: Theme.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyList: {
    flex: 1,
  },
});
