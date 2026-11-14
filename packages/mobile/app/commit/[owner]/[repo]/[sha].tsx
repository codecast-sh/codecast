// One commit on the phone, the twin of the web's /commit/<owner>/<repo>/<sha>:
// what changed (message, counts, every file's diff) and who inside codecast
// made it happen (the session that wrote it, the pull request it belongs to,
// the tasks it names), each one tap away. Reads the store; commits.webGet
// feeds it and resolves an abbreviated sha.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { parsePatch } from '@codecast/convex/convex/fileChanges/patchParser';
import { repoObjectGitHubUrl, repoObjectId } from '@codecast/shared/entities';
import { useRepoObject } from '@codecast/web/hooks/useRepoObject';
import { useSyncPullRequest, usePullRequest } from '@codecast/web/hooks/useSyncTimeline';
import { useSessionTrailer } from '@codecast/web/hooks/useSessionTrailer';
import { useEnsureCommitFiles } from '@codecast/web/hooks/useRepoBrowse';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { commitCarriesDiffs } from '@codecast/shared/contracts/commitDiffs';
import { PR_STATE_META, prStateKey } from '@codecast/web/lib/prView';
import { accentVar } from '@codecast/web/lib/externalEvents';
import { splitCommitMessage } from '@codecast/web/lib/repoView';
import { useInboxStore, useTrackedStore } from '@codecast/web/store/inboxStore';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { copyToClipboard } from '@/lib/clipboard';
import { solColor } from '@/lib/solColor';
import { RelativeTime } from '@/components/RelativeTime';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { DiffFileHeader, FileDiffCards, type FileDiff } from '@/components/CastDiff';
import { ObjectHeader, ObjectMissing, SectionLabel, LinkRow, objectStyles } from '@/components/objects/ObjectParts';

const api = _api as any;

const FILES_SHOWN = 20;

type CommitFile = { filename: string; status?: string; additions?: number; deletions?: number; patch?: string };

const FILE_STATUS: Record<string, FileDiff['status']> = { added: 'added', removed: 'deleted', deleted: 'deleted', modified: 'modified', renamed: 'modified', changed: 'modified' };

/** The commit's accent, as the web page draws it: green when it mostly added, red when it mostly removed. */
function balanceColor(ins: number, del: number, t: Palette): string {
  const total = ins + del;
  if (total === 0) return t.textDim;
  const added = ins / total;
  return added >= 0.7 ? t.green : added <= 0.3 ? t.red : t.yellow;
}

export default function CommitScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { owner, repo, sha: rawSha } = useLocalSearchParams<{ owner: string; repo: string; sha: string }>();
  const repository = `${owner}/${repo}`.toLowerCase();
  const sha = (rawSha ?? '').toLowerCase();
  const refId = repoObjectId({ type: 'commit', repository, sha });
  const { entity: commit, ready } = useRepoObject('commit', refId, { repository, sha });
  const c = commit as any;

  const { message, session: trailerSession } = useSessionTrailer(c?.message);
  const { subject, body } = splitCommitMessage(message);
  const sessionId: string | null = c?.conversation_id ?? trailerSession ?? null;

  useSyncPullRequest(c?.pr_number ? { repository: c.repository ?? repository, number: c.pr_number } : 'skip');
  const pr = usePullRequest(c?.repository ?? repository, c?.pr_number ?? -1);

  const taskIds: string[] = c?.task_ids ?? [];
  const s = useTrackedStore([
    (st) => (sessionId ? (st.sessions[sessionId]?.title ?? st.conversations?.[sessionId]?.title ?? '') : ''),
    (st) => taskIds.map((id) => `${st.tasks[id]?.short_id ?? ''}|${st.tasks[id]?.title ?? ''}|${st.tasks[id]?.status ?? ''}`).join('\n'),
  ]);
  const storedTitle = sessionId ? (s.sessions[sessionId]?.title ?? (s as any).conversations?.[sessionId]?.title) : undefined;
  const servedSession = useQueryNoThrow(api.conversations.webGet, sessionId && !storedTitle ? { id: sessionId } : 'skip').data as any;
  const sessionTitle = storedTitle || servedSession?.title || null;

  const files: CommitFile[] = c?.files ?? [];
  const carries = commitCarriesDiffs(files as any);
  const fetchFiles = useEnsureCommitFiles(c?.repository ?? repository, c?.sha, !!c && !carries);
  const diffs = useMemo(
    () => files.map((f): FileDiff => ({ path: f.filename, status: FILE_STATUS[f.status ?? ''] ?? 'modified', hunks: f.patch ? parsePatch(f.patch).hunks : [] })),
    [files],
  );
  const [allFiles, setAllFiles] = useState(false);

  if (!c) {
    const github = repoObjectGitHubUrl({ type: 'commit', repository, sha });
    return <ObjectMissing what="Commit" id={sha.slice(0, 7)} loading={!ready} action={{ label: 'Open on GitHub', onPress: () => void WebBrowser.openBrowserAsync(github) }} />;
  }

  const fullSha: string = c.sha;
  const github = repoObjectGitHubUrl({ type: 'commit', repository: c.repository ?? repository, sha: fullSha });
  const ins = c.insertions ?? 0;
  const del = c.deletions ?? 0;
  const accent = balanceColor(ins, del, Theme);
  const author = c.author_login || c.author_name;
  const withDiff = diffs.filter((d) => d.hunks.length > 0);
  const withoutDiff = diffs.filter((d) => d.hunks.length === 0);
  const shownDiffs = allFiles ? withDiff : withDiff.slice(0, FILES_SHOWN);
  const fileCount = Math.max(c.files_changed ?? 0, files.length);
  const prState = pr ? PR_STATE_META[prStateKey(pr)] : null;
  const tasks = taskIds.map((id) => s.tasks[id]).filter(Boolean) as any[];

  return (
    <>
      <ObjectHeader
        type="commit"
        shortId={fullSha.slice(0, 7)}
        refId={repoObjectId({ type: 'commit', repository: c.repository ?? repository, sha: fullSha })}
        title={subject || fullSha.slice(0, 7)}
        menu={[
          { label: 'Open on GitHub', onPress: () => void WebBrowser.openBrowserAsync(github) },
          { label: 'Copy full sha', onPress: () => { void copyToClipboard(fullSha); } },
        ]}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="commit-screen">
        <RNView style={styles.repoRow}>
          <FontAwesome name="code-fork" size={12} color={accent} />
          <RNText style={styles.repo} numberOfLines={1}>{c.repository ?? repository}</RNText>
        </RNView>
        <RNText style={objectStyles.title} selectable>{subject || fullSha.slice(0, 7)}</RNText>
        {body ? (
          <RNView style={styles.body}>
            <CollapsibleBody fadeColor={Theme.bg} height={140}>
              <RNText style={styles.bodyText} selectable>{body}</RNText>
            </CollapsibleBody>
          </RNView>
        ) : null}

        <RNView style={styles.metaRow}>
          {author ? <RNText style={styles.metaStrong} numberOfLines={1}>{author}</RNText> : null}
          {c.timestamp ? <RelativeTime timestamp={c.timestamp} style={styles.meta} /> : null}
          {c.branch ? (
            <RNView style={styles.branch}>
              <FontAwesome name="code-fork" size={10} color={Theme.textMuted} />
              <RNText style={styles.branchText} numberOfLines={1}>{c.branch}</RNText>
            </RNView>
          ) : null}
        </RNView>

        <RNView style={styles.stats} testID="commit-stats">
          <TouchableOpacity onPress={() => void copyToClipboard(fullSha)} activeOpacity={0.6} style={[styles.sha, { borderColor: accent + '55', backgroundColor: accent + '14' }]}>
            <RNText style={[styles.shaText, { color: accent }]}>{fullSha.slice(0, 7)}</RNText>
            <FontAwesome name="copy" size={10} color={accent} style={{ opacity: 0.7 }} />
          </TouchableOpacity>
          <RNText style={[styles.count, { color: Theme.green }]}>+{ins}</RNText>
          <RNText style={[styles.count, { color: Theme.red }]}>−{del}</RNText>
          {ins + del > 0 ? (
            <RNView style={[styles.balance, { backgroundColor: Theme.red + '99' }]}>
              <RNView style={{ width: `${Math.round((ins / (ins + del)) * 100)}%`, height: '100%', backgroundColor: Theme.green }} />
            </RNView>
          ) : null}
          <RNText style={styles.meta}>{fileCount} {fileCount === 1 ? 'file' : 'files'}</RNText>
        </RNView>

        {(sessionId || c.pr_number || tasks.length > 0) && (
          <RNView style={objectStyles.section}>
            <SectionLabel>Made by</SectionLabel>
            <RNView style={objectStyles.list}>
              {sessionId ? (
                <LinkRow
                  icon="comments-o"
                  color={Theme.blue}
                  title={sessionTitle || 'Session'}
                  meta={sessionTitle ? undefined : sessionId.slice(0, 7)}
                  onPress={() => router.push(`/session/${sessionId}` as never)}
                  testID="commit-session"
                />
              ) : null}
              {c.pr_number ? (
                <LinkRow
                  icon="code-fork"
                  color={prState ? solColor(accentVar(prState.accent), Theme) : Theme.green}
                  title={pr?.title ? `#${c.pr_number} ${pr.title}` : `Pull request #${c.pr_number}`}
                  meta={prState?.label}
                  onPress={() => router.push(`/pr/${c.repository ?? repository}/${c.pr_number}` as never)}
                  testID="commit-pr"
                />
              ) : null}
              {tasks.map((t) => (
                <LinkRow
                  key={t._id}
                  icon={t.status === 'done' ? 'check-circle' : 'circle-o'}
                  color={t.status === 'done' ? Theme.green : Theme.violet}
                  title={t.title || t.short_id}
                  meta={t.short_id}
                  onPress={() => router.push(`/task/${t.short_id ?? t._id}` as never)}
                />
              ))}
            </RNView>
          </RNView>
        )}

        <RNView style={objectStyles.section}>
          <SectionLabel>{`Files · ${fileCount}`}</SectionLabel>
          {withDiff.length > 0 ? <FileDiffCards files={shownDiffs} /> : null}
          {withDiff.length > FILES_SHOWN && (
            <TouchableOpacity style={styles.more} onPress={() => setAllFiles((v) => !v)} activeOpacity={0.6}>
              <RNText style={styles.moreText}>{allFiles ? 'Show fewer' : `${withDiff.length - FILES_SHOWN} more files`}</RNText>
              <FontAwesome name={allFiles ? 'angle-up' : 'angle-down'} size={13} color={Theme.textMuted0} />
            </TouchableOpacity>
          )}
          {withoutDiff.length > 0 && (
            <RNView style={[objectStyles.list, withDiff.length > 0 && { marginTop: Spacing.sm }]}>
              {withoutDiff.map((d, i) => {
                const f = files.find((x) => x.filename === d.path);
                return (
                  <RNView key={`${d.path}:${i}`} style={styles.fileRow}>
                    <DiffFileHeader path={d.path} status={d.status} additions={f?.additions ?? 0} deletions={f?.deletions ?? 0} />
                  </RNView>
                );
              })}
            </RNView>
          )}
          {!carries && (
            <RNText style={styles.note} testID="commit-diff-note">
              {fetchFiles.pending || fetchFiles.reason === 'requested'
                ? "Reading this commit's diff…"
                : fetchFiles.error
                  ? "The diff for this commit couldn't be read."
                  : files.length
                    ? 'GitHub has the diffs for these files.'
                    : 'No file changes to show for this commit.'}
            </RNText>
          )}
        </RNView>

        <TouchableOpacity style={styles.github} onPress={() => void WebBrowser.openBrowserAsync(github)} activeOpacity={0.6}>
          <FontAwesome name="github" size={15} color={Theme.text} />
          <RNText style={styles.githubText}>Comments on GitHub</RNText>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  repoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  repo: { ...codeFont, fontSize: 12, color: Theme.textMuted, flexShrink: 1 },
  body: { marginTop: -Spacing.xs, marginBottom: Spacing.md },
  bodyText: { ...codeFont, fontSize: 12, lineHeight: 18, color: Theme.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: Spacing.sm },
  metaStrong: { fontSize: 13, fontWeight: '600', color: Theme.text, maxWidth: 180 },
  meta: { fontSize: 12.5, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, maxWidth: 220 },
  branchText: { ...codeFont, fontSize: 11.5, color: Theme.textMuted, flexShrink: 1 },
  stats: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: Spacing.xl },
  sha: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  shaText: { ...codeFont, fontSize: 12, fontWeight: '600' },
  count: { ...codeFont, fontSize: 12.5, fontWeight: '600' },
  balance: { width: 48, height: 5, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  fileRow: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  note: { fontSize: 12.5, color: Theme.textMuted0, marginTop: Spacing.sm },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 2 },
  moreText: { fontSize: 12.5, fontWeight: '600', color: Theme.textMuted },
  github: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    paddingVertical: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
  },
  githubText: { fontSize: 14, fontWeight: '600', color: Theme.text },
}));
