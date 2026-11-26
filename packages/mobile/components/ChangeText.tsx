// A change on the phone (docs/architecture/changes.md CH3-CH4), drawn as text so
// it wraps with the line it sits in: the web chip's five bars and glyph, after a
// pull request's or commit's pill name, and a branch named in a message as its
// whole chip when a checkout, a pull request or a deploy queue knows it. The
// rule and the words are the web's (lib/changes/lifecycle).
import React from 'react';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { useTheme, type Palette } from '@/constants/Theme';
import { useMentionedChange } from '@codecast/web/hooks/useMentionedChange';
import { useChangeReach, type RepoChange } from '@codecast/web/hooks/useRepoChanges';
import { vehicleName, type ChangeTone, type Lifecycle, type LifecycleStage, type StageState } from '@codecast/web/lib/changes/lifecycle';

const FAILED_TINT = '33';

/** The web's change tones in the phone's palette. */
const changeColor = (t: Palette, tone: ChangeTone) =>
  ({ yellow: t.yellow, muted: t.textMuted, blue: t.blue, orange: t.orange, red: t.red, green: t.green, dim: t.textDim })[tone];

/** One bar as the web draws it: passed solid, the now in its tone (hollow while it waits its turn), skipped dashed, ahead faint. */
function Bar({ s, lifecycle, Theme }: { s: LifecycleStage; lifecycle: Lifecycle; Theme: Palette }) {
  const n = lifecycle.now;
  const isNow = s.id === n.stage;
  const live = n.tone === 'green';
  if (s.state === 'skipped') return <RNText style={{ color: Theme.textDim, opacity: 0.6, letterSpacing: -1 }}>╌</RNText>;
  if (isNow && s.state === 'waiting') return <RNText style={{ color: Theme.textMuted, letterSpacing: -1 }}>▭</RNText>;
  const color = isNow ? changeColor(Theme, n.tone) : live ? Theme.green : s.state === 'done' ? Theme.textMuted : Theme.textDim;
  return <RNText style={{ color, opacity: isNow || live || s.state === 'done' ? 1 : 0.4, letterSpacing: -1 }}>▬</RNText>;
}

/** The now's state as a glyph, as the web chip draws it (components/changes/ChangeChip NODE). Idle has none. */
const NOW_GLYPH: Record<StageState, React.ComponentProps<typeof Feather>['name'] | null> = {
  done: 'check',
  active: 'disc',
  waiting: 'clock',
  you: 'user',
  back: 'corner-down-left',
  failed: 'x',
  skipped: 'minus',
  stopped: 'slash',
  idle: null,
};

/** A change's track and the now's glyph in its tone. The word is the change's to say on its screen, never a label in a line. */
export function ChangeWords({ lifecycle }: { lifecycle: Lifecycle }) {
  const Theme = useTheme();
  const n = lifecycle.now;
  const tone = changeColor(Theme, n.tone);
  const glyph = NOW_GLYPH[n.state];
  return (
    <RNText style={{ color: tone }} accessibilityLabel={`${n.word}${n.detail ? `, ${n.detail}` : ''}`}>
      {' '}
      {lifecycle.stages.map((s) => <Bar key={s.id} s={s} lifecycle={lifecycle} Theme={Theme} />)}
      {glyph ? <>{' '}<Feather name={glyph} size={10} color={tone} style={n.tone === 'red' ? { backgroundColor: Theme.red + FAILED_TINT } : undefined} /></> : null}
    </RNText>
  );
}

/** A change named in a message, whole: its glyph and name, then its track and state glyph. A pull request opens its screen. */
function ChangeLine({ lifecycle, label, pr, repository }: { lifecycle: Lifecycle; label: string; pr: number | null; repository: string | null }) {
  const Theme = useTheme();
  const router = useRouter();
  const [owner, repo] = (repository ?? '').split('/');
  const open = pr && owner && repo ? () => router.push(`/pr/${owner}/${repo}/${pr}`) : undefined;
  return (
    <RNText onPress={open} accessibilityLabel={`${vehicleName(lifecycle.vehicle)}: ${lifecycle.now.word}`} style={{ color: Theme.text }}>
      <Feather name={lifecycle.vehicle.kind === 'pr' ? 'git-pull-request' : 'git-branch'} size={11} color={Theme.textMuted} />
      {' '}
      <RNText style={{ fontFamily: 'JetBrainsMono-Regular', fontSize: 12 }}>{label}</RNText>
      <ChangeWords lifecycle={lifecycle} />
    </RNText>
  );
}

function KnownBranch({ change, label }: { change: RepoChange; label: string }) {
  useChangeReach(change.reach_ref);
  return <ChangeLine lifecycle={change.lifecycle} label={label} pr={change.refs.pr} repository={change.repository} />;
}

/**
 * Inline code in a message: a branch the conversation's repository knows draws as its change, as on the web
 * (components/EntityIdPill EntityAwareCode); anything else stays the code it was written as (`children`).
 */
export function MentionedCode({ value, children }: { value: string; children: React.ReactNode }) {
  // The phone reads no GitHub branch list (ChangesContext BranchFeed), so a name is never looked up on its own here.
  const change = useMentionedChange(value, false);
  if (change && change !== 'unlisted') return <KnownBranch change={change} label={value} />;
  return <>{children}</>;
}
