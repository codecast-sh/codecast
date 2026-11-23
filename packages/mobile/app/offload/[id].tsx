// A machine's offload review, the phone twin of the web's /resources?offload=<id>
// panel: the machine's CPU and memory now and after the move, a dial for how
// much session load to move off, the hosts receiving it with their own load,
// every movable session as a tickable row (what it frees, where it goes, what
// the source machine's dry run found), busy sessions that stay with
// background priority, and the rest grouped by why they stay. Move starts the
// launch and the screen then follows it: per-session status, Retry, Cancel.
//
// The review state is the web's own (useOffloadReview), the plan comes from
// the same monitor (useResourceMonitor) and the commands are the same store
// actions (useOffloadCommands). The "machine overloaded" notification opens it.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { appAlert, showActionSheet } from '@/lib/popups';
import { ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useResourceMonitor, useSyncMachineResource } from '@codecast/web/hooks/useResourceMonitor';
import { useOffloadCommands } from '@codecast/web/hooks/useOffloadCommands';
import { AUTO, SAFE_WAITS, movable, useOffloadReview } from '@codecast/web/components/resources/offloadReviewState';
import { fmtAgo, fmtBytes, fmtCpu } from '@codecast/web/components/resources/resourceModel';
import { SPREAD_CEILING, loadShift } from '@codecast/web/lib/resourceOffload';
import { ROW_STATUS_LABEL, isRowActive, type MigrationRowStatus } from '@codecast/web/lib/migrationPlan';
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadRehearsal, OffloadRun, ResourceSession, StayingSession } from '@codecast/web/components/resources/types';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (n: number | undefined) => (n === undefined ? '?' : `${Math.round(n)}%`);
const homeShort = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^.*Uncaught (Convex)?Error:\s*/s, '').split('\n')[0];

const REPORTING = {
  fail: (surface: string) => (e: unknown) => { console.warn(`[offload] ${surface}`, e); appAlert('Could not do that', errText(e)); },
  notice: (text: string) => appAlert(text),
};

function Feeder({ deviceId }: { deviceId: string }) {
  useSyncMachineResource(deviceId);
  return null;
}

/** Every machine's report: the source's load and each receiving host's. */
function MachineFeeders() {
  const ids = useInboxStore((s) => (s.machineRoster as Array<{ device_id: string }>).map((d) => d.device_id).sort().join(','));
  return <>{ids ? ids.split(',').map((id) => <Feeder key={id} deviceId={id} />) : null}</>;
}

export default function OffloadScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const deviceId = rawId?.trim() ?? '';
  const data = useResourceMonitor();
  const { commands, plans } = useOffloadCommands(data.sessions, data.plans, data.batches, data.now, data.rehearsals, REPORTING);
  const [launched, setLaunched] = useState<string | null>(null);
  const machine = data.machines.find((m) => m.deviceId === deviceId);
  const plan = plans.find((p) => p.deviceId === deviceId);
  const names = useMemo(() => new Map(data.machines.map((m) => [m.deviceId, m.name])), [data.machines]);
  const name = machine?.name ?? 'this machine';

  let body;
  if (launched) {
    body = <Progress runs={data.runs.filter((r) => r.clientBatchId === launched)} name={name} sessions={data.sessions} names={names} commands={commands} />;
  } else if (plan) {
    body = <Review key={plan.deviceId} plan={plan} name={name} sessions={data.sessions} now={data.now} commands={commands} runs={data.runs} names={names} onStarted={setLaunched} />;
  } else {
    body = (
      <ObjectMissing
        what="Machine"
        id={machine?.name}
        loading={!data.ready || (!!machine && machine.role === 'local' && !machine.snapshot)}
      />
    );
  }
  return <><MachineFeeders />{body}</>;
}

type Commands = ReturnType<typeof useOffloadCommands>['commands'];

/** One measure before and after: the leaving part fades, the arriving part is lit. */
function LoadBar({ label, before, after }: { label: string; before?: number; after?: number }) {
  const Theme = useTheme();
  if (before === undefined) return null;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const end = after ?? before;
  const lo = clamp(Math.min(before, end)), hi = clamp(Math.max(before, end));
  const rising = end > before;
  const tone = end > 100 ? Theme.red : end > SPREAD_CEILING ? Theme.yellow : Theme.cyan;
  const changed = after !== undefined && Math.round(after) !== Math.round(before);
  return (
    <RNView style={styles.barRow}>
      <RNText style={styles.barLabel} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
      <RNView style={styles.track}>
        <RNView style={[styles.fill, { width: `${lo}%`, backgroundColor: rising ? Theme.textMuted0 + '80' : tone }]} />
        {hi > lo && <RNView style={[styles.fill, { left: `${lo}%`, width: `${hi - lo}%`, backgroundColor: rising ? tone : Theme.textMuted0 + '40' }]} />}
      </RNView>
      <RNText style={styles.barValue} maxFontSizeMultiplier={CHROME_FONT_CAP}>
        {pct(before)}
        {changed ? <RNText style={{ color: Theme.textMuted0 }}> → </RNText> : null}
        {changed ? <RNText style={{ color: end > 100 ? Theme.red : end > SPREAD_CEILING ? Theme.yellow : Theme.text, fontWeight: '600' }}>{pct(after)}</RNText> : null}
      </RNText>
    </RNView>
  );
}

function Chip({ label, color, on, onPress, icon, strike, disabled, testID }: {
  label: string; color: string; on?: boolean; onPress?: () => void; icon?: React.ComponentProps<typeof FontAwesome>['name']; strike?: boolean; disabled?: boolean; testID?: string;
}) {
  const inner = (
    <>
      {icon ? <FontAwesome name={icon} size={10} color={color} /> : null}
      <RNText style={[styles.chipText, { color }, strike && styles.strike]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
    </>
  );
  const style = [styles.chip, { borderColor: color + '66' }, on && { backgroundColor: color + '1c' }, disabled && { opacity: 0.4 }];
  return onPress
    ? <TouchableOpacity style={style} onPress={onPress} disabled={disabled} activeOpacity={0.6} accessibilityRole="button" accessibilityState={{ selected: !!on, disabled: !!disabled }} testID={testID}>{inner}</TouchableOpacity>
    : <RNView style={style} testID={testID}>{inner}</RNView>;
}

const destIcon = (d: OffloadDestination): 'laptop' | 'cloud' => (d.role === 'local' ? 'laptop' : 'cloud');

function Review({ plan: livePlan, name, sessions, now, commands, runs, names, onStarted }: {
  plan: OffloadPlan; name: string; sessions: ResourceSession[]; now: number; commands: Commands; runs: OffloadRun[]; names: Map<string, string>; onStarted: (id: string) => void;
}) {
  const Theme = useTheme();
  const r = useOffloadReview({ plan: livePlan, sessions, actions: commands });
  const { plan, going, receiving, canMove } = r;
  const [openReason, setOpenReason] = useState<string | null>(null);
  const incident = plan.incident;
  const tone = incident ? (incident.level === 'critical' ? Theme.red : Theme.yellow) : Theme.green;
  const sample = plan.sourceSample;
  const pickMode = () => showActionSheet('Move to', [
    { label: 'Spread automatically', selected: r.mode === AUTO, onPress: () => r.setMode(AUTO) },
    ...r.reachable.map((d) => ({ label: `${d.name}${d.asleep ? ' (asleep)' : ''}`, selected: r.mode === d.deviceId, onPress: () => r.setMode(d.deviceId) })),
  ]);
  const pickWait = () => showActionSheet('Wait for a working turn up to', SAFE_WAITS.map((p) => ({
    label: p.label.replace(/^wait up to /i, ''), selected: r.wait === p.value, onPress: () => r.setWait(p.value),
  })));
  // Hosts this session can go to first; a blocked one names why and does nothing.
  const pickHost = (c: OffloadCandidate) => showActionSheet(r.titleOf(c.sessionId), [...plan.destinations]
    .sort((a, b) => Number(movable(c.perDestination[b.deviceId])) - Number(movable(c.perDestination[a.deviceId])))
    .map((d) => {
      const usable = movable(c.perDestination[d.deviceId]);
      return {
        label: usable ? d.name : `${d.name}: ${c.perDestination[d.deviceId]?.blockers[0] ?? 'blocked'}`,
        selected: r.destOf(c) === d.deviceId,
        onPress: () => { if (usable) r.pinDestination(c, d.deviceId); },
      };
    }));
  const press = () => { const id = r.start(); if (id) onStarted(id); };
  // Like the web's run strip: every recent offload that still has work or a failure to retry.
  const otherRuns = runs.filter((run) => run.rows.some((row) => isRowActive(row.status) || row.status === 'queued' || row.status === 'failed'));

  return (
    <>
      <Stack.Screen options={{ title: 'Offload', headerRight: undefined }} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} numberOfLines={2}>Free up {name}</RNText>
        <RNView style={objectStyles.chips}>
          <Chip icon="circle" color={tone} label={incident ? `${incident.reason} · ${fmtAgo(incident.since, now).replace(/ ago$/, '')}` : 'No sustained pressure'} testID="offload-incident" />
          {sample.processCount === undefined ? <Chip color={Theme.yellow} label="session usage not measured" /> : null}
          {going.length > 0 ? <Chip color={r.stoppingOutside ? Theme.orange : Theme.textMuted} label={`${r.stopping.length} ${r.stopping.length === 1 ? 'process stops' : 'processes stop'}${r.stoppingOutside ? ` · ${r.stoppingOutside} outside` : ''}`} /> : null}
        </RNView>

        <RNView style={[styles.card, styles.pad]} testID="offload-source">
          <RNView style={styles.cardHead}>
            <FontAwesome name="laptop" size={13} color={Theme.textMuted} />
            <RNText style={styles.cardName} numberOfLines={1}>{name}</RNText>
            {plan.usageAt !== undefined ? <RNText style={styles.dim}>usage {fmtAgo(plan.usageAt, now)}</RNText> : null}
          </RNView>
          <LoadBar label="CPU" before={r.source.before.cpu} after={going.length ? r.source.after.cpu : undefined} />
          <LoadBar label="Memory" before={r.source.before.memory} after={going.length ? r.source.after.memory : undefined} />
        </RNView>

        {plan.destinations.length === 0 ? (
          <RNView style={[styles.card, styles.pad, styles.gap]}>
            <RNText style={styles.dim}>No cloud host set up</RNText>
          </RNView>
        ) : (
          <>
            {r.poolShare > 0 && (
              <RNView style={[styles.card, styles.pad, styles.gap]} testID="offload-dial">
                <RNView style={styles.dialHead}>
                  <RNText style={styles.dim}>Move off</RNText>
                  <RNText style={styles.dialValue}>{r.dialValue}%</RNText>
                  <RNText style={[styles.dim, styles.right]} numberOfLines={1}>
                    {going.length === 0 ? 'nothing' : [plural(going.length, 'session'), r.leaving.cpu !== undefined ? fmtCpu(r.leaving.cpu) : undefined, fmtBytes(r.leaving.rss)].filter(Boolean).join(' · ')}
                  </RNText>
                </RNView>
                <RNView style={styles.track}>
                  <RNView style={[styles.fill, { width: `${r.dialValue}%`, backgroundColor: Theme.cyan }]} />
                </RNView>
                <RNView style={styles.steps}>
                  <TouchableOpacity onPress={() => r.setDial(Math.max(0, r.dialValue - 5))} hitSlop={8} accessibilityLabel="Move less" style={styles.stepper}>
                    <FontAwesome name="minus" size={11} color={Theme.textMuted} />
                  </TouchableOpacity>
                  {[0, 25, 50, 75, 100].map((n) => (
                    <TouchableOpacity key={n} onPress={() => r.setDial(n)} hitSlop={6} style={[styles.preset, n === r.dialValue && { backgroundColor: Theme.cyan + '22' }]} testID={`offload-dial-${n}`}>
                      <RNText style={[styles.presetText, n === r.dialValue && { color: Theme.text, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{n}%</RNText>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={() => r.setDial(Math.min(100, r.dialValue + 5))} hitSlop={8} accessibilityLabel="Move more" style={styles.stepper}>
                    <FontAwesome name="plus" size={11} color={Theme.textMuted} />
                  </TouchableOpacity>
                </RNView>
              </RNView>
            )}

            <RNView style={objectStyles.section}>
              <SectionLabel right={r.reachable.length > 1 ? (
                <TouchableOpacity onPress={pickMode} hitSlop={8} style={styles.inline} testID="offload-mode">
                  <RNText style={styles.link} maxFontSizeMultiplier={CHROME_FONT_CAP}>{r.mode === AUTO ? `Spread${r.hostsUsed > 1 ? ` · ${r.hostsUsed} hosts` : ''}` : plan.destinations.find((d) => d.deviceId === r.mode)?.name}</RNText>
                  <FontAwesome name="angle-down" size={12} color={Theme.accent} />
                </TouchableOpacity>
              ) : undefined}>Move to</SectionLabel>
              {receiving.length === 0 ? <RNText style={objectStyles.empty}>Nothing ticked</RNText> : null}
              {receiving.map(({ d, cs }) => {
                const shift = d.sample ? loadShift(d.sample, r.sumOf(cs), 1) : undefined;
                return (
                  <RNView key={d.deviceId} style={[styles.card, styles.pad, styles.gapSm]} testID={`offload-host-${d.deviceId}`}>
                    <RNView style={styles.cardHead}>
                      <FontAwesome name={destIcon(d)} size={13} color={Theme.cyan} />
                      <RNText style={styles.cardName} numberOfLines={1}>{d.name}</RNText>
                      {d.asleep || !d.online ? <RNText style={styles.dim}>{d.asleep ? 'asleep, wakes' : 'offline'}</RNText> : null}
                      <RNText style={[styles.dim, styles.right]}>{[plural(cs.length, 'session'), d.costPerHour !== undefined ? `$${d.costPerHour.toFixed(2)}/h` : undefined].filter(Boolean).join(' · ')}</RNText>
                    </RNView>
                    {shift ? (
                      <>
                        <LoadBar label="CPU" before={shift.before.cpu} after={cs.length ? shift.after.cpu : undefined} />
                        <LoadBar label="Memory" before={shift.before.memory} after={cs.length ? shift.after.memory : undefined} />
                      </>
                    ) : <RNText style={styles.dim}>Load not measured yet</RNText>}
                  </RNView>
                );
              })}
            </RNView>

            {plan.staying.length > 0 && (
              <RNView style={objectStyles.section}>
                <SectionLabel right={<RNText style={styles.dim}>{fmtCpu(plan.staying.reduce((n, s) => n + s.cpu, 0))}</RNText>}>{`Busy, staying · ${plan.staying.length}`}</SectionLabel>
                <RNView style={styles.card}>
                  {plan.staying.map((st, i) => <StayingRow key={st.sessionId} s={st} title={r.titleOf(st.sessionId)} first={i === 0} onBackground={r.setBackground} />)}
                </RNView>
              </RNView>
            )}

            {canMove.length > 0 && (
              <RNView style={objectStyles.section}>
                <SectionLabel right={canMove.length > 1 ? (
                  <TouchableOpacity onPress={() => r.setAll(!r.allChecked)} hitSlop={8} testID="offload-all">
                    <RNText style={styles.link} maxFontSizeMultiplier={CHROME_FONT_CAP}>{r.allChecked ? 'Select none' : 'Select all'}</RNText>
                  </TouchableOpacity>
                ) : undefined}>{`Sessions · ${canMove.length}`}</SectionLabel>
                <RNView style={styles.card}>
                  {canMove.map((c, i) => (
                    <CandidateRow
                      key={c.sessionId}
                      c={c}
                      first={i === 0}
                      title={r.titleOf(c.sessionId)}
                      checked={r.picked.includes(c)}
                      host={plan.destinations.length > 1 ? plan.destinations.find((d) => d.deviceId === r.destOf(c)) : r.shownHost(c)}
                      onCheck={(v) => r.check(c, v)}
                      onHost={plan.destinations.length > 1 ? () => pickHost(c) : undefined}
                      rehearsal={r.rehearsalOf(c)}
                      bring={r.bringOf(c)}
                      onBring={(path, on) => r.setBring(c, path, on)}
                    />
                  ))}
                </RNView>
              </RNView>
            )}

            {r.stayCount > 0 && (
              <RNView style={objectStyles.section}>
                <SectionLabel>{`${r.busy.size ? 'Also staying' : 'Staying'} · ${r.stayCount}`}</SectionLabel>
                <RNView style={styles.card}>
                  {r.stayGroups.map(([reason, ids], i) => (
                    <RNView key={reason} style={i > 0 && styles.rule}>
                      <TouchableOpacity style={styles.row} onPress={() => setOpenReason(openReason === reason ? null : reason)} activeOpacity={0.6}>
                        <FontAwesome name={openReason === reason ? 'angle-down' : 'angle-right'} size={13} color={Theme.textMuted0} style={styles.caret} />
                        <RNText style={[styles.rowTitle, styles.grow]} numberOfLines={2}>{reason}</RNText>
                        <RNText style={styles.num}>{ids.length}</RNText>
                      </TouchableOpacity>
                      {openReason === reason ? ids.map((id) => <RNText key={id} style={styles.stayTitle} numberOfLines={1}>{r.titleOf(id)}</RNText>) : null}
                    </RNView>
                  ))}
                </RNView>
              </RNView>
            )}

            {otherRuns.length > 0 && (
              <RNView style={objectStyles.section}>
                <SectionLabel>Moves in progress</SectionLabel>
                {otherRuns.map((run) => <RunCard key={run.batchId} run={run} sessions={sessions} names={names} commands={commands} />)}
              </RNView>
            )}
          </>
        )}
      </ScrollView>

      {plan.destinations.length > 0 && (
        <RNView style={styles.footer}>
          {r.midTurn ? (
            <TouchableOpacity onPress={pickWait} style={styles.waitRow} hitSlop={6} testID="offload-wait">
              <FontAwesome name="clock-o" size={12} color={Theme.yellow} />
              <RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>Working sessions wait up to {SAFE_WAITS.find((p) => p.value === r.wait)?.label.replace(/^wait up to /i, '').toLowerCase()}</RNText>
              <FontAwesome name="angle-down" size={12} color={Theme.textMuted0} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={press}
            disabled={!!r.moveBlocked}
            activeOpacity={0.8}
            style={[styles.move, { backgroundColor: r.moveBlocked ? Theme.bgHighlight : Theme.cyan }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!r.moveBlocked }}
            testID="offload-move"
          >
            <FontAwesome name="arrow-right" size={13} color={r.moveBlocked ? Theme.textMuted0 : Theme.bg} />
            <RNText style={[styles.moveText, { color: r.moveBlocked ? Theme.textMuted0 : Theme.bg }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {r.moveBlocked && going.length === 0 ? 'Select a session' : `Move ${going.length > 0 ? plural(going.length, 'session') : 'sessions'}`}
            </RNText>
          </TouchableOpacity>
        </RNView>
      )}
    </>
  );
}

function CandidateRow({ c, title, checked, host, first, onCheck, onHost, rehearsal, bring, onBring }: {
  c: OffloadCandidate; title: string; checked: boolean; host?: OffloadDestination; first: boolean; onCheck: (v: boolean) => void; onHost?: () => void;
  rehearsal?: OffloadRehearsal; bring: string[]; onBring: (path: string, on: boolean) => void;
}) {
  const Theme = useTheme();
  const outside = c.stops.filter((p) => p.detached).length;
  const relief = [c.relief.cpu !== undefined ? fmtCpu(c.relief.cpu) : undefined, c.relief.rssHigh !== undefined ? fmtBytes(c.relief.rssHigh) : undefined].filter(Boolean).join(' · ');
  return (
    <RNView style={[!first && styles.rule, !checked && { opacity: 0.55 }]} testID={`offload-candidate-${c.sessionId}`}>
      <TouchableOpacity style={styles.row} onPress={() => onCheck(!checked)} activeOpacity={0.6} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={`Move ${title}`}>
        <FontAwesome name={checked ? 'check-square' : 'square-o'} size={18} color={checked ? Theme.cyan : Theme.textMuted0} style={styles.box} />
        <RNView style={styles.grow}>
          <RNText style={styles.rowTitle} numberOfLines={2}>{title}</RNText>
          <RNText style={styles.dim} numberOfLines={1}>
            {relief}
            {c.disruption === 'mid_turn' ? <RNText style={{ color: Theme.yellow }}>{relief ? ' · ' : ''}working</RNText> : null}
            {outside ? <RNText style={{ color: Theme.orange }}>{' · '}stops {outside} outside</RNText> : null}
          </RNText>
        </RNView>
        {checked && (host || onHost) ? (
          <TouchableOpacity onPress={onHost} disabled={!onHost} hitSlop={6} style={styles.inline} accessibilityRole="button" accessibilityLabel={`Host for ${title}: ${host?.name ?? 'pick'}`} testID={`offload-host-pick-${c.sessionId}`}>
            {host ? <FontAwesome name={destIcon(host)} size={11} color={Theme.textMuted} /> : null}
            <RNText style={[styles.dim, styles.hostName]} numberOfLines={1}>{host?.name ?? 'host'}</RNText>
            {onHost ? <FontAwesome name="angle-down" size={11} color={Theme.textMuted0} /> : null}
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
      <Rehearsal rehearsal={rehearsal} bring={bring} onBring={onBring} disabled={!checked} />
    </RNView>
  );
}

/** What the source machine's dry run found for one move: each path the host lacks as a toggle that brings it, then what stays or differs. */
function Rehearsal({ rehearsal, bring, onBring, disabled }: { rehearsal?: OffloadRehearsal; bring: string[]; onBring: (path: string, on: boolean) => void; disabled: boolean }) {
  const Theme = useTheme();
  if (!rehearsal) return null;
  if (rehearsal.status === 'pending') return <RNText style={[styles.dim, styles.under]}>checking the move…</RNText>;
  if (rehearsal.status === 'failed') return <RNText style={[styles.dim, styles.under]} numberOfLines={2}>not checked: {rehearsal.error}</RNText>;
  const r = rehearsal.result;
  const running = r.services.filter((sv) => sv.running);
  const lacks = r.tools.missing.filter((t) => !r.tools.installs.includes(t));
  if (!r.missing.length && !running.length && !lacks.length && !r.tools.installs.length && !r.machine.length) return null;
  return (
    <RNView style={[styles.chipRow, styles.under]}>
      {r.missing.map((m) => {
        const on = bring.includes(m.path);
        return (
          <Chip
            key={m.path}
            icon={on ? 'check' : undefined}
            color={on ? Theme.cyan : Theme.orange}
            on={on}
            strike={!on}
            disabled={disabled}
            label={`${homeShort(m.path)}${m.bytes !== undefined ? ` ${fmtBytes(m.bytes)}` : ''}`}
            onPress={() => onBring(m.path, !on)}
          />
        );
      })}
      {running.map((sv) => <Chip key={sv.label} color={Theme.orange} label={`${sv.label} stays`} />)}
      {r.tools.installs.length > 0 ? <Chip color={Theme.textMuted} label={`installs ${r.tools.installs.join(', ')}`} /> : null}
      {lacks.length > 0 ? <Chip color={Theme.orange} label={`lacks ${lacks.join(', ')}`} /> : null}
      {r.machine.map((m) => <Chip key={m} color={Theme.orange} label={m.replace(' here, ', ' → ').replace(' on the host', '')} />)}
    </RNView>
  );
}

function StayingRow({ s, title, first, onBackground }: { s: StayingSession; title: string; first: boolean; onBackground?: (sessionId: string, on: boolean) => void }) {
  const Theme = useTheme();
  const applied = s.background && s.lowered > 0;
  return (
    <RNView style={[styles.row, !first && styles.rule]} testID={`offload-staying-${s.sessionId}`}>
      <RNView style={styles.grow}>
        <RNText style={styles.rowTitle} numberOfLines={2}>{title}</RNText>
        <RNText style={styles.dim} numberOfLines={2}>{fmtCpu(s.cpu)} · {fmtBytes(s.rss)} · {s.reason}</RNText>
      </RNView>
      <Chip
        icon={applied ? 'check' : s.background ? 'hourglass-half' : undefined}
        color={s.background ? Theme.cyan : Theme.textMuted}
        on={s.background}
        label={applied ? `Background ${s.lowered}/${s.processCount}` : 'Background'}
        disabled={!onBackground}
        onPress={onBackground ? () => onBackground(s.sessionId, !s.background) : undefined}
      />
    </RNView>
  );
}

const statusColor = (s: MigrationRowStatus, t: Palette) => ({
  queued: t.textMuted, waiting_idle: t.yellow, quiescing: t.orange, transferring: t.blue, switching: t.violet,
  resuming: t.cyan, done: t.green, failed: t.red, cancelled: t.textMuted0,
}[s]);

const runActive = (run: OffloadRun) => run.rows.some((r) => isRowActive(r.status) || r.status === 'queued');

/** One run (one destination's batch): a row per session with its status, Retry when it failed, and Cancel for the rest. */
function RunCard({ run, sessions, names, commands }: { run: OffloadRun; sessions: ResourceSession[]; names: Map<string, string>; commands: Commands }) {
  const Theme = useTheme();
  const title = (id: string) => sessions.find((s) => s.sessionId === id)?.title ?? id;
  const cancellable = runActive(run) && !run.cancelUnavailable;
  return (
    <RNView style={[styles.card, styles.gapSm]} testID={`offload-run-${run.batchId}`}>
      {run.rows.map((row, i) => (
        <RNView key={row.sessionId} style={[styles.row, i > 0 && styles.rule]}>
          <RNView style={styles.grow}>
            <RNText style={styles.rowTitle} numberOfLines={1}>{title(row.sessionId)}</RNText>
            <RNText style={styles.dim} numberOfLines={1}>→ {names.get(row.destinationId) ?? row.destinationId}</RNText>
            {row.error ? <RNText style={[styles.dim, { color: Theme.red }]} numberOfLines={3}>{row.error}</RNText> : null}
          </RNView>
          <Chip color={statusColor(row.status, Theme)} on label={ROW_STATUS_LABEL[row.status]} />
          {row.status === 'failed' ? <Chip icon="repeat" color={Theme.cyan} label="Retry" onPress={() => commands.onRetry?.(run.batchId, row.sessionId)} /> : null}
        </RNView>
      ))}
      {runActive(run) ? (
        <TouchableOpacity
          style={[styles.row, styles.rule, { justifyContent: 'center', opacity: cancellable ? 1 : 0.4 }]}
          disabled={!cancellable}
          onPress={() => commands.onCancel?.(run.batchId)}
          activeOpacity={0.6}
          testID={`offload-cancel-${run.batchId}`}
        >
          <RNText style={[styles.link, { color: Theme.red }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{run.cancelUnavailable ? 'Cancel after preflight' : 'Cancel remaining'}</RNText>
        </TouchableOpacity>
      ) : null}
    </RNView>
  );
}

const STAGES = ['done', 'moving', 'queued', 'failed', 'cancelled'] as const;

/** After Move: the launch followed to the end. */
function Progress({ runs, name, sessions, names, commands }: { runs: OffloadRun[]; name: string; sessions: ResourceSession[]; names: Map<string, string>; commands: Commands }) {
  const Theme = useTheme();
  const router = useRouter();
  const rows = runs.flatMap((r) => r.rows);
  const count = (f: (s: MigrationRowStatus) => boolean) => rows.filter((r) => f(r.status)).length;
  const stages = { done: count((s) => s === 'done'), moving: count(isRowActive), queued: count((s) => s === 'queued'), failed: count((s) => s === 'failed'), cancelled: count((s) => s === 'cancelled') };
  const tones = { done: Theme.green, moving: Theme.cyan + '80', queued: Theme.textMuted0 + '66', failed: Theme.red, cancelled: Theme.textMuted0 + '33' };
  const active = !rows.length || runs.some(runActive);
  const tone = active ? Theme.cyan : stages.failed ? Theme.red : Theme.green;
  return (
    <>
      <Stack.Screen options={{ title: 'Offload', headerRight: undefined }} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} numberOfLines={2}>{active ? 'Moving' : 'Moved'} off {name}</RNText>
        <RNView style={objectStyles.chips}>
          <Chip icon="circle" color={tone} label={!rows.length ? 'Starting' : active ? 'In progress, never interrupts a turn' : stages.failed ? `${stages.failed} failed` : 'Finished'} />
        </RNView>
        <RNView style={[styles.card, styles.pad, styles.gap]} testID="offload-progress">
          <RNView style={styles.dialHead}>
            <RNText style={styles.dialValue}>{stages.done}<RNText style={{ color: Theme.textMuted0 }}>/{rows.length}</RNText></RNText>
            <RNText style={styles.dim}>moved</RNText>
            <RNText style={[styles.dim, styles.right]}>
              {[stages.moving && `${stages.moving} moving`, stages.queued && `${stages.queued} queued`, stages.failed && `${stages.failed} failed`].filter(Boolean).join(' · ')}
            </RNText>
          </RNView>
          <RNView style={[styles.track, { flexDirection: 'row' }]}>
            {STAGES.map((k) => stages[k] > 0 ? <RNView key={k} style={{ width: `${(stages[k] / rows.length) * 100}%`, backgroundColor: tones[k] }} /> : null)}
          </RNView>
        </RNView>
        {runs.map((run) => <RunCard key={run.batchId} run={run} sessions={sessions} names={names} commands={commands} />)}
      </ScrollView>
      <RNView style={styles.footer}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.move, { backgroundColor: active ? Theme.bgHighlight : Theme.cyan }]} activeOpacity={0.8} testID="offload-done">
          <RNText style={[styles.moveText, { color: active ? Theme.text : Theme.bg }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{active ? 'Hide' : 'Done'}</RNText>
        </TouchableOpacity>
      </RNView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden', marginBottom: Spacing.sm },
  pad: { paddingHorizontal: 12, paddingVertical: 10 },
  gap: { gap: 8, marginBottom: Spacing.lg },
  gapSm: { gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  cardName: { fontSize: 13, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  right: { marginLeft: 'auto' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  barLabel: { width: 62, fontSize: 12, color: Theme.textMuted0 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Theme.borderLight + '66', overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: 3 },
  barValue: { minWidth: 78, textAlign: 'right', fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  dialHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  dialValue: { fontSize: 22, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  steps: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  preset: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
  presetText: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  grow: { flex: 1, minWidth: 0 },
  box: { width: 20 },
  caret: { width: 12 },
  rowTitle: { fontSize: 14, fontWeight: '500', color: Theme.text },
  stayTitle: { fontSize: 13, color: Theme.textMuted, paddingLeft: 34, paddingRight: 12, paddingBottom: 6 },
  num: { fontSize: 13, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  dim: { fontSize: 12, color: Theme.textMuted0 },
  link: { fontSize: 12, fontWeight: '600', color: Theme.accent },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hostName: { maxWidth: 96 },
  under: { paddingLeft: 42, paddingRight: 12, paddingBottom: 10, marginTop: -4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 240 },
  chipText: { fontSize: 11, fontWeight: '500', flexShrink: 1 },
  strike: { textDecorationLine: 'line-through' },
  footer: { paddingHorizontal: Spacing.lg, paddingTop: 10, paddingBottom: 30, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, backgroundColor: Theme.bg },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' },
  move: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 10 },
  moveText: { fontSize: 15, fontWeight: '700' },
}));
