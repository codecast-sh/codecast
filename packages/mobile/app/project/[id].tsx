// A project on the phone: its name, status, lead and target day, what it is
// for, how much of its board is done, the goals it serves, and its plans,
// tasks and sessions as rows that open their own screens. The primary verb
// is the web's default view: open the project's session. Reads the store
// (projects, tasks and plans are fed app-wide; goals are fed here).
import { useMemo, useState } from 'react';
import { ScrollView, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { useInboxStore, type ProjectItem } from '@codecast/web/store/inboxStore';
import { windowOrgTree } from '@codecast/web/store/orgSlice';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInitiatives, useSyncInitiatives } from '@codecast/web/hooks/useInitiatives';
import { initiativesOfProject, initiativeProgress } from '@codecast/web/lib/initiatives';
import { projectDefaultSessionOf } from '@codecast/web/lib/projectDefaultSession';
import { sessionsUnder } from '@codecast/web/components/org/goalsLayout';
import type { OrgTree } from '@codecast/web/components/org/orgTypes';
import { isOnProjectBoard } from '@codecast/shared/tasks';
import { useFeedLoading } from '@/hooks/useSyncWorkspaceData';
import { TaskItemRow, showTaskActions } from '@/components/TaskItem';
import { PlanItemRow } from '@/components/PlanItem';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { showActionSheet, appPrompt } from '@/lib/popups';
import { FactChip, LinkRow, ObjectHeader, ObjectMissing, ProgressBlock, SectionLabel, SessionsBlock, objectStyles as styles, targetChip } from '@/components/objects/ObjectParts';
import { goalStatusVisual, projectStatusVisual, PROJECT_STATUS_ORDER, sessionRowsFor } from '@/components/objects/objectStatus';
import { EntityKindIcon, ProjectStatusMark } from '@/components/marks';

export default function ProjectScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useCoarseNow(60_000);
  useSyncInitiatives();
  const loading = useFeedLoading('projects');

  // The address names a project by its `pj-` id; an older link by its Convex id.
  const project = useInboxStore((s) => (id ? (s.projects as Record<string, ProjectItem>)[id] ?? Object.values(s.projects as Record<string, ProjectItem>).find((p) => p.short_id === id) : undefined));
  if (!project) return <ObjectMissing what="Project" id={id} loading={loading} />;
  return <ProjectBody project={project} now={now} Theme={Theme} router={router} />;
}

function ProjectBody({ project, now, Theme, router }: { project: ProjectItem; now: number; Theme: ReturnType<typeof useTheme>; router: ReturnType<typeof useRouter> }) {
  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const updateTask = useInboxStore((s) => s.updateTask);
  const updateProject = useInboxStore((s) => s.updateProject);
  const tree = useInboxStore(windowOrgTree) as OrgTree | null;
  const defaultSessionId = useInboxStore((s) => projectDefaultSessionOf(project, s.sessions, windowOrgTree(s)?.roles as any));
  // Sessions in the project: the inbox's rows tagged with it, plus every
  // session of a role whose area holds it (the org tree's word).
  const sessionsSig = useInboxStore((s) => Object.values(s.sessions).filter((x) => x.project_id === project._id).map((x) => `${x._id}:${x.updated_at}`).join(','));
  const sessions = useMemo(() => sessionRowsFor(useInboxStore.getState().sessions, [project._id], tree ? sessionsUnder(tree, [project._id]) : []), [sessionsSig, tree, project._id]); // eslint-disable-line react-hooks/exhaustive-deps
  const goals = useInitiatives();
  const serves = useMemo(() => initiativesOfProject(goals, project._id), [goals, project._id]);
  const [showDone, setShowDone] = useState(false);

  // The board's rows, by the same rule the progress bar counts (projectTaskCounts).
  const boardTasks = useMemo(
    () => Object.values(tasks).filter((t) => String(t.project_id ?? '') === project._id && isOnProjectBoard(t as any)),
    [tasks, project._id],
  );
  const progress = useMemo(() => initiativeProgress({ project_ids: [project._id] }, Object.values(tasks) as any), [tasks, project._id]);
  const open = boardTasks.filter((t) => t.status !== 'done' && t.status !== 'dropped')
    .sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const done = boardTasks.filter((t) => t.status === 'done');
  const projectPlans = useMemo(
    () => Object.values(plans).filter((p) => String(p.project_id ?? '') === project._id && p.status !== 'abandoned')
      .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    [plans, project._id],
  );

  const status = projectStatusVisual(project.status, Theme);
  const lead = project.owner_role_id ? tree?.roles.find((r) => String(r._id) === String(project.owner_role_id)) : undefined;
  const target = project.target_date ? targetChip(project.target_date, now, project.status === 'done', Theme) : null;
  const about = (project.goal || project.description || '').trim();

  const pickStatus = () => showActionSheet('Status', PROJECT_STATUS_ORDER.map((s) => ({
    label: projectStatusVisual(s, Theme).label,
    selected: projectStatusVisual(s, Theme).label === status.label,
    onPress: () => updateProject(project._id, { status: s }),
  })));
  const rename = () => appPrompt('Rename project', {
    defaultValue: project.title,
    confirm: 'Save',
    accepts: (t) => !!t.trim() && t.trim() !== project.title,
    onSubmit: (title) => updateProject(project._id, { title: title.trim() }),
  });

  return (
    <>
      <ObjectHeader type="project" shortId={project.short_id} title={project.title} menu={[{ label: 'Rename', onPress: rename }, { label: 'Change status', onPress: pickStatus }]} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} testID={`project-screen-${project.short_id ?? project._id}`}>
        <RNText style={styles.title}>{project.title}</RNText>
        <RNView style={styles.chips}>
          <FactChip mark={<ProjectStatusMark status={project.status} size={11} />} label={status.label} color={status.color} onPress={pickStatus} testID="project-status" />
          {lead && <FactChip icon="user-o" label={`@${lead.handle}`} color={Theme.textSecondary} link onPress={() => router.push(`/org/${lead.short_id}` as never)} />}
          {target && <FactChip icon="calendar-o" label={target.label} color={target.color} />}
        </RNView>

        {defaultSessionId && (
          <TouchableOpacity style={[styles.primary, { backgroundColor: Theme.cyan }]} activeOpacity={0.75} onPress={() => router.push(`/session/${defaultSessionId}` as never)} testID="project-open-session">
            <FontAwesome name="comment-o" size={14} color={Theme.bg} />
            <RNText style={styles.primaryText}>Open project session</RNText>
          </TouchableOpacity>
        )}

        {about ? (
          <RNView style={styles.section}>
            <CollapsibleBody fadeColor={Theme.bg} height={140}>
              <MarkdownContent text={about} baseStyle={styles.body} />
            </CollapsibleBody>
          </RNView>
        ) : null}

        <ProgressBlock progress={progress} />

        {serves.length > 0 && (
          <RNView style={styles.section}>
            <SectionLabel>Serves</SectionLabel>
            <RNView style={styles.list}>
              {serves.map((g) => {
                const v = goalStatusVisual(g.status, Theme);
                return <LinkRow key={g._id} mark={<EntityKindIcon type="initiative" size={13} color={v.color} />} color={v.color} title={g.title} meta={v.label} onPress={() => router.push(`/goal/${g.short_id || g._id}` as never)} />;
              })}
            </RNView>
          </RNView>
        )}

        {projectPlans.length > 0 && (
          <RNView style={styles.section}>
            <SectionLabel>{`Plans · ${projectPlans.length}`}</SectionLabel>
            <RNView style={styles.list}>
              {projectPlans.map((p) => <PlanItemRow key={p._id} plan={p} onPress={() => router.push(`/plan/${p.short_id}` as never)} />)}
            </RNView>
          </RNView>
        )}

        <RNView style={styles.section}>
          <SectionLabel>{`Tasks · ${open.length} open`}</SectionLabel>
          {open.length > 0 ? (
            <RNView style={styles.list}>
              {open.map((t) => <TaskItemRow key={t._id} task={t} onPress={() => router.push(`/task/${t.short_id}` as never)} onLongPress={() => showTaskActions(t, updateTask)} />)}
            </RNView>
          ) : <RNText style={styles.empty}>No open tasks</RNText>}
          {done.length > 0 && (
            <TouchableOpacity style={styles.ghost} onPress={() => setShowDone((v) => !v)} activeOpacity={0.6}>
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.ghostText, { color: Theme.textMuted }]}>{showDone ? 'Hide done' : `${done.length} done`}</RNText>
              <FontAwesome name={showDone ? 'angle-up' : 'angle-down'} size={13} color={Theme.textMuted} />
            </TouchableOpacity>
          )}
          {showDone && done.length > 0 && (
            <RNView style={styles.list}>
              {done.map((t) => <TaskItemRow key={t._id} task={t} onPress={() => router.push(`/task/${t.short_id}` as never)} onLongPress={() => showTaskActions(t, updateTask)} />)}
            </RNView>
          )}
        </RNView>

        <SessionsBlock sessions={sessions} />
      </ScrollView>
    </>
  );
}
