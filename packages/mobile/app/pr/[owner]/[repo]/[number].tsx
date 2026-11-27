// A pull request on the phone: where it stands (state, merge readiness,
// review decision), its checks with failures first, its reviews, and the
// sessions that worked on it. The data and every rule about it are web's PR
// page's (hooks/useSyncTimeline, usePRDetails, lib/prView); the diff and line
// threads stay on GitHub, one tap away. A merged one also says where it runs
// in production, target by target (web's components/pr/PRDeploy).
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { repoObjectGitHubUrl } from '@codecast/shared/entities';
import { checkLabel } from '@codecast/shared/contracts';
import { useSyncPullRequest, usePullRequest } from '@codecast/web/hooks/useSyncTimeline';
import { usePRDetails } from '@codecast/web/hooks/usePRDetails';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { accentVar, type ExternalEventAccent } from '@codecast/web/lib/externalEvents';
import {
  CHECK_OUTCOME_ACCENT, PR_STATE_META, REVIEW_STATE_ACCENT,
  checkOutcome, compareChecks, foldChecks, mergeStateMeta, prStateKey, reviewDecisionMeta, type PrCheck,
} from '@codecast/web/lib/prView';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { api } from '@codecast/convex/convex/_generated/api';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { solColor } from '@/lib/solColor';
import { formatRelativeTime } from '@/components/SessionItem';
import Feather from '@expo/vector-icons/Feather';
import { useDeployReach } from '@codecast/web/hooks/useDeployReach';
import { useDeployTargets } from '@codecast/web/hooks/useSyncDeployTargets';
import { teamWorkspaceKey } from '@codecast/web/lib/workspaceScope';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { repoObjectId } from '@codecast/web/lib/entityLinks';
import { REACH_LOOK, deployAgo } from '@codecast/web/lib/deploys/deployPill';
import { prDeployRows, prReachHeadline, prRowLine, prRowParts } from '@codecast/web/lib/deploys/prDeploy';
import { toneColor } from '@/components/EntityPill';
import { WebIcon } from '@/components/marks';
import { REACH_ICON } from '@codecast/web/lib/deploys/deployLook';

const color = (accent: ExternalEventAccent | undefined, Theme: Palette) => solColor(accentVar(accent), Theme);

// The web PR page's production band (components/pr/PRDeploy): the same rows and the same words (prRowParts),
// read-only. The press that sends a deploy lives on web's Deploys page and its confirm flow.
function useProductionRows(pr: any, repository: string) {
  const merged = pr?.state === 'merged';
  const reach = useDeployReach(merged ? repoObjectId({ type: 'pr', repository, number: pr.number }) : null);
  const { targets, deploys } = useDeployTargets(merged ? teamWorkspaceKey(pr?.team_id as string | undefined) : null, repository);
  const now = useCoarseNow(30_000);
  const model = useMemo(() => prDeployRows(reach, targets, deploys, repository, now), [reach, targets, deploys, repository, now]);
  return { ...model, headline: prReachHeadline(reach?.state, model.rows), now, mergedAt: (pr?.merged_at as number | undefined) ?? null };
}

export default function PullRequestScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { owner, repo, number: num } = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const repository = `${owner}/${repo}`;
  const number = Number(num);
  const feed = useSyncPullRequest(Number.isFinite(number) ? { repository, number } : 'skip');
  const pr = usePullRequest(repository, number);
  const prId = pr?._id as string | undefined;
  const details = usePRDetails(prId, pr?.head_sha, prId ? 'checks' : null);
  const { data: reviews } = useQueryNoThrow(api.reviews.getReviewsForPR, prId ? { pull_request_id: prId as any } : 'skip');
  const sessions = useInboxStore((s) => s.sessions);
  const linked = useMemo(
    () => ((pr?.linked_session_ids ?? []) as string[]).map((id) => sessions[id]).filter(Boolean),
    [pr?.linked_session_ids, sessions],
  );
  const githubUrl = repoObjectGitHubUrl({ type: 'pr', repository, number } as any);
  const [showPassed, setShowPassed] = useState(false);
  const production = useProductionRows(pr, repository);

  if (!pr) {
    return (
      <>
        <Stack.Screen options={{ title: `#${num}` }} />
        <RNView style={styles.center}>
          {feed.ready ? <RNText style={styles.dim}>This pull request isn't synced to codecast.</RNText> : <ActivityIndicator color={Theme.textMuted} />}
          <TouchableOpacity style={styles.githubButton} onPress={() => void WebBrowser.openBrowserAsync(githubUrl)}>
            <RNText style={styles.githubText}>Open on GitHub</RNText>
          </TouchableOpacity>
        </RNView>
      </>
    );
  }

  const state = PR_STATE_META[prStateKey(pr)];
  const merge = mergeStateMeta(pr);
  const decision = reviewDecisionMeta(pr.review_decision);
  const checks = [...((pr.checks ?? []) as PrCheck[])].sort(compareChecks);
  const fold = foldChecks(pr.checks);
  // Passing checks say nothing a count can't; they fold so the ones needing
  // attention lead. When every check passed, the list stays folded too.
  const passed = checks.filter((c) => checkOutcome(c) === 'passed');
  const shown = showPassed ? checks : checks.filter((c) => checkOutcome(c) !== 'passed');

  return (
    <>
      <Stack.Screen options={{ title: `#${pr.number}` }} />
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{pr.title}</RNText>
        <RNView style={styles.chips}>
          <Chip label={state.label} color={color(state.accent, Theme)} />
          {production.headline && (
            <Chip
              label={production.headline.words}
              color={toneColor(Theme, REACH_LOOK[production.headline.state].tone)}
              icon={REACH_ICON[production.headline.state]}
            />
          )}
          {merge && <Chip label={merge.label} color={color(merge.accent, Theme)} />}
          {decision && <Chip label={decision.label} color={color(decision.accent, Theme)} />}
        </RNView>
        <RNText style={styles.meta} numberOfLines={2}>
          {pr.author_github_username ? `${pr.author_github_username} · ` : ''}{pr.head_ref} → {pr.base_ref}
          {pr.additions != null ? `  +${pr.additions} −${pr.deletions ?? 0}` : ''}
        </RNText>

        {production.rows.length + production.dormant.length > 0 && (
          <Section title="Production">
            {production.rows.map((row, i) => {
              const tint = toneColor(Theme, REACH_LOOK[row.state].tone);
              const to = row.deploy ?? row.now;
              return (
                <TouchableOpacity key={`${row.target}#${i}`} style={styles.prodRow} disabled={!to} onPress={() => to && router.push(`/deploy/${to.short_id}`)}>
                  <RNView style={styles.row}>
                    <WebIcon icon={REACH_ICON[row.state]} size={15} color={tint} />
                    <RNText style={styles.rowTitle} numberOfLines={1}>{row.target}</RNText>
                    <RNText style={[styles.rowMeta, { color: tint }]}>{REACH_LOOK[row.state].word}</RNText>
                  </RNView>
                  <RNText style={styles.prodDetail} numberOfLines={2}>{prRowLine(prRowParts(row, production.now, production.mergedAt))}</RNText>
                  {row.note ? <RNText style={[styles.prodDetail, { color: Theme.red }]} numberOfLines={2}>{row.note}</RNText> : null}
                </TouchableOpacity>
              );
            })}
            {production.dormant.map((t, i) => (
              <RNView key={`${t.target}#idle${i}`} style={styles.row}>
                <Feather name="circle" size={15} color={Theme.textDim} />
                <RNText style={[styles.rowTitle, styles.dimRow]} numberOfLines={1}>{t.target}</RNText>
                <RNText style={[styles.rowMeta, { color: Theme.textDim }]}>idle{t.at ? ` · ${deployAgo(t.at, production.now)}` : ''}</RNText>
              </RNView>
            ))}
          </Section>
        )}

        <Section title={fold.total ? `Checks · ${fold.failed ? `${fold.failed} failed · ` : ''}${fold.passed}/${fold.total} passed` : 'Checks'}>
          {checks.length === 0 ? (
            details.loading ? <ActivityIndicator color={Theme.textMuted} /> : <RNText style={styles.dim}>No checks</RNText>
          ) : shown.map((c, i) => {
            const outcome = checkOutcome(c);
            const tint = color(CHECK_OUTCOME_ACCENT[outcome], Theme);
            return (
              <TouchableOpacity key={`${checkLabel(c)}-${i}`} style={styles.row} disabled={!c.url} onPress={() => c.url && void WebBrowser.openBrowserAsync(c.url)}>
                <FontAwesome name={outcome === 'passed' ? 'check-circle' : outcome === 'failed' ? 'times-circle' : outcome === 'pending' ? 'clock-o' : 'minus-circle'} size={15} color={tint} />
                <RNText style={styles.rowTitle} numberOfLines={1}>{checkLabel(c)}</RNText>
                <RNText style={[styles.rowMeta, { color: tint }]}>{(c.conclusion || c.status || '').replace(/_/g, ' ')}</RNText>
              </TouchableOpacity>
            );
          })}
          {passed.length > 0 && !showPassed ? (
            <TouchableOpacity style={styles.row} onPress={() => setShowPassed(true)}>
              <FontAwesome name="check-circle" size={15} color={color(CHECK_OUTCOME_ACCENT.passed, Theme)} />
              <RNText style={[styles.rowTitle, styles.dimRow]}>{passed.length} passed</RNText>
              <FontAwesome name="angle-down" size={14} color={Theme.textMuted} />
            </TouchableOpacity>
          ) : null}
        </Section>

        {(reviews as any[] | undefined)?.length ? (
          <Section title="Reviews">
            {(reviews as any[]).map((r) => (
              <RNView key={r._id} style={styles.review}>
                <RNView style={styles.row}>
                  <RNText style={styles.rowTitle}>{r.author_github_username}</RNText>
                  <RNText style={[styles.rowMeta, { color: color(REVIEW_STATE_ACCENT[String(r.state).toLowerCase()], Theme) }]}>
                    {String(r.state).toLowerCase().replace(/_/g, ' ')}
                  </RNText>
                </RNView>
                {r.body ? <RNText style={styles.reviewBody} numberOfLines={4}>{r.body}</RNText> : null}
              </RNView>
            ))}
          </Section>
        ) : null}

        {linked.length > 0 && (
          <Section title="Sessions">
            {linked.map((s: any) => (
              <TouchableOpacity key={s._id} style={styles.row} onPress={() => router.push(`/session/${s._id}`)}>
                <FontAwesome name="comments-o" size={14} color={Theme.textMuted} />
                <RNText style={styles.rowTitle} numberOfLines={1}>{s.title || 'Untitled session'}</RNText>
                <RNText style={styles.rowMeta}>{formatRelativeTime(s.updated_at)}</RNText>
              </TouchableOpacity>
            ))}
          </Section>
        )}

        <TouchableOpacity style={styles.githubButton} onPress={() => void WebBrowser.openBrowserAsync(githubUrl)}>
          <FontAwesome name="github" size={15} color={Theme.text} />
          <RNText style={styles.githubText}>Diff and comments on GitHub</RNText>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

/** `icon`: a web glyph (lucide), drawn natively. */
function Chip({ label, color, icon }: { label: string; color: string; icon?: unknown }) {
  return (
    <RNView style={[styles.chip, { borderColor: color + '66', backgroundColor: color + '1a' }]}>
      {icon ? <WebIcon icon={icon} size={11} color={color} /> : null}
      <RNText style={[styles.chipText, { color }]}>{label}</RNText>
    </RNView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  useTheme();
  return (
    <RNView style={styles.section}>
      <RNText style={styles.sectionTitle}>{title}</RNText>
      {children}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: Theme.bg },
  content: { padding: Spacing.lg, paddingBottom: Spacing.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, backgroundColor: Theme.bg, padding: Spacing.lg },
  title: { fontSize: 18, fontWeight: '700', color: Theme.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '600' },
  meta: { fontSize: 12, color: Theme.textMuted, marginTop: Spacing.sm },
  section: { marginTop: Spacing.xl, gap: 2 },
  sectionTitle: { fontSize: 11, fontWeight: '600', color: Theme.textMuted0, marginBottom: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 9 },
  rowTitle: { flex: 1, fontSize: 14, color: Theme.text },
  rowMeta: { fontSize: 12, color: Theme.textMuted },
  review: { paddingVertical: 4 },
  prodRow: { paddingBottom: 6 },
  prodDetail: { fontSize: 12, color: Theme.textMuted, marginLeft: 15 + Spacing.sm, marginTop: -4 },
  reviewBody: { fontSize: 13, color: Theme.textMuted, marginBottom: Spacing.sm },
  dim: { fontSize: 13, color: Theme.textMuted },
  dimRow: { color: Theme.textMuted },
  githubButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    marginTop: Spacing.xl, paddingVertical: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
  },
  githubText: { fontSize: 14, fontWeight: '600', color: Theme.text },
}));
