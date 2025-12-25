import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, ScrollView } from 'react-native';
import { Text, View } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';

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
  if (diffMinutes === 1) return "1 min ago";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  if (diffHours === 1) return "1 hr ago";
  if (diffHours < 24) return `${diffHours} hr ago`;
  if (diffDays === 1) return "yesterday";

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getEventColor(eventType: string): string {
  switch (eventType) {
    case "session_started":
    case "session_completed":
      return "#eab308";
    case "commit_pushed":
      return "#8b5cf6";
    case "member_joined":
      return "#10b981";
    case "member_left":
      return "#ef4444";
    case "pr_created":
    case "pr_merged":
      return "#3b82f6";
    default:
      return "#888";
  }
}

type ActivityEventItemProps = {
  event: ActivityEvent;
  onPress?: () => void;
};

function ActivityEventItem({ event, onPress }: ActivityEventItemProps) {
  const actorName = event.actor?.name || event.actor?.email || "Unknown";
  const eventColor = getEventColor(event.event_type);

  const content = (
    <View style={styles.eventCard}>
      <View style={[styles.eventIndicator, { backgroundColor: eventColor }]} />
      <View style={styles.eventContent}>
        <View style={styles.eventHeader}>
          <Text style={styles.eventTitle} numberOfLines={2}>
            {event.title}
          </Text>
          <Text style={styles.eventTime}>
            {formatRelativeTime(event.timestamp)}
          </Text>
        </View>
        <View style={styles.eventMeta}>
          <Text style={styles.metaText}>{actorName}</Text>
          {event.metadata?.git_branch && (
            <>
              <Text style={styles.metaSeparator}>•</Text>
              <Text style={styles.metaText}>{event.metadata.git_branch}</Text>
            </>
          )}
          {event.metadata?.message_count !== undefined && (
            <>
              <Text style={styles.metaSeparator}>•</Text>
              <Text style={styles.metaText}>{event.metadata.message_count} msg</Text>
            </>
          )}
          {event.metadata?.files_changed !== undefined && (
            <>
              <Text style={styles.metaSeparator}>•</Text>
              <Text style={styles.metaText}>{event.metadata.files_changed} files</Text>
            </>
          )}
        </View>
        {event.description && (
          <Text style={styles.eventDescription} numberOfLines={1}>
            {event.description}
          </Text>
        )}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} style={styles.eventTouchable}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

type FilterOption = {
  label: string;
  value: string | undefined;
};

const EVENT_TYPE_FILTERS: FilterOption[] = [
  { label: "All Events", value: undefined },
  { label: "Sessions", value: "session_completed" },
  { label: "Commits", value: "commit_pushed" },
  { label: "Members", value: "member_joined" },
  { label: "PRs", value: "pr_created" },
];

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
      <View style={styles.memberCard}>
        <View style={styles.memberAvatar}>
          <Text style={styles.memberAvatarText}>
            {item.name?.[0]?.toUpperCase() || item.email?.[0]?.toUpperCase() || "?"}
          </Text>
          {isOnline && <View style={styles.onlineIndicator} />}
        </View>
        <View style={styles.memberInfo}>
          <Text style={styles.memberName}>{item.name || "Unnamed"}</Text>
          <Text style={styles.memberEmail}>{item.email}</Text>
          <Text style={styles.memberLastSeen}>{lastSeen}</Text>
        </View>
        {item.role === "admin" && (
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>ADMIN</Text>
          </View>
        )}
      </View>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyText}>
        {view === "activity"
          ? "No team activity yet.\nTeam activity will appear as members work."
          : "No team members found."}
      </Text>
    </View>
  );

  if (!currentUser?.team_id) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            You are not part of a team.{'\n'}Join or create a team to see activity.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, view === "activity" && styles.tabActive]}
          onPress={() => setView("activity")}
        >
          <Text style={[styles.tabText, view === "activity" && styles.tabTextActive]}>
            Activity
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, view === "directory" && styles.tabActive]}
          onPress={() => setView("directory")}
        >
          <Text style={[styles.tabText, view === "directory" && styles.tabTextActive]}>
            Directory
          </Text>
        </TouchableOpacity>
      </View>

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
              >
                <Text
                  style={[
                    styles.filterChipText,
                    eventTypeFilter === filter.value && styles.filterChipTextActive,
                  ]}
                >
                  {filter.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <FlatList
            data={events}
            renderItem={renderActivityItem}
            keyExtractor={(item) => item._id}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={activityResult === undefined ? null : renderEmpty}
            contentContainerStyle={events.length === 0 ? styles.emptyList : styles.listContent}
          />
        </>
      )}

      {view === "directory" && (
        <FlatList
          data={teamMembers || []}
          renderItem={renderTeamMemberItem}
          keyExtractor={(item) => item._id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={teamMembers === undefined ? null : renderEmpty}
          contentContainerStyle={(teamMembers?.length || 0) === 0 ? styles.emptyList : styles.listContent}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#fff',
  },
  tabText: {
    fontSize: 16,
    color: '#888',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  filterContainer: {
    maxHeight: 60,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#222',
    borderWidth: 1,
    borderColor: '#333',
  },
  filterChipActive: {
    backgroundColor: '#eab308',
    borderColor: '#eab308',
  },
  filterChipText: {
    fontSize: 14,
    color: '#888',
  },
  filterChipTextActive: {
    color: '#000',
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
  },
  eventTouchable: {
    marginBottom: 12,
  },
  eventCard: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    overflow: 'hidden',
  },
  eventIndicator: {
    width: 4,
  },
  eventContent: {
    flex: 1,
    padding: 12,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  eventTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#fff',
    marginRight: 8,
  },
  eventTime: {
    fontSize: 11,
    color: '#666',
  },
  eventMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 12,
    color: '#888',
  },
  metaSeparator: {
    color: '#666',
    marginHorizontal: 6,
  },
  eventDescription: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 12,
  },
  memberAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    position: 'relative',
  },
  memberAvatarText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#10b981',
    borderWidth: 2,
    borderColor: '#1a1a1a',
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
    marginBottom: 2,
  },
  memberEmail: {
    fontSize: 13,
    color: '#888',
    marginBottom: 2,
  },
  memberLastSeen: {
    fontSize: 11,
    color: '#666',
  },
  adminBadge: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  adminBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    lineHeight: 24,
  },
  emptyList: {
    flex: 1,
  },
});
