// The Vault on the phone: the team's and the viewer's secrets as metadata,
// open requests on top with a masked field to fill each one, and a sheet with
// a secret's details and recent activity. A typed value lives in this screen's
// state and goes straight to secrets.fulfill; it never reaches the store.
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAction } from 'convex/react';
import Feather from '@expo/vector-icons/Feather';
import { api } from '@codecast/convex/convex/_generated/api';
import { envFor, type SecretKind, type SecretMeta } from '@codecast/shared/contracts/secrets';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useSecrets, useSyncSecrets, useVaultKeys } from '@codecast/web/hooks/useSyncSecrets';
import { EMPTY_DRAFT, EVENT_TONE, EVENT_VERB, checkedPayload, type ValueDraft } from '@codecast/web/components/secrets/vaultModel';
import { Text as RNText, TextInput } from '@/components/Themed';
import { EntityPill } from '@/components/EntityPill';
import { formatRelativeTime } from '@/components/sessionFormat';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { SettingsScroll, SettingsGroup, settingsStyles } from './SettingsUI';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type Tone = 'yellow' | 'blue' | 'violet' | 'cyan';

const KIND: Record<SecretKind, { icon: FeatherName; tone: Tone; label: string }> = {
  key: { icon: 'key', tone: 'yellow', label: 'Key' },
  login: { icon: 'user', tone: 'blue', label: 'Login' },
  file: { icon: 'file-text', tone: 'violet', label: 'File' },
  signin: { icon: 'globe', tone: 'cyan', label: 'Sign-in' },
};

/** A stub from a create on another surface has no short id until the server answers. */
const isStub = (row: SecretMeta) => !row.short_id;

/** The env vars a secret fills, or its site for a sign-in. */
function whereUsed(row: SecretMeta): string {
  if (row.kind === 'signin') return row.sites?.join(', ') ?? '';
  return envFor(row).map((b) => b.var).join(' ');
}

function KindGlyph({ kind }: { kind: SecretKind }) {
  const Theme = useTheme();
  const k = KIND[kind];
  return (
    <RNView style={[styles.glyph, { backgroundColor: Theme[k.tone] + '22' }]}>
      <Feather name={k.icon} size={14} color={Theme[k.tone]} />
    </RNView>
  );
}

function useTeamName(teamKey: string | null): string | null {
  return useInboxStore((s) => {
    if (!teamKey) return null;
    const team = (s.teams as any[]).find((t) => t && `team:${t._id}` === teamKey);
    return team?.name ?? null;
  });
}

export function VaultPage() {
  useTheme();
  useSyncSecrets();
  const rows = useSecrets();
  const { team, personal } = useVaultKeys();
  const teamName = useTeamName(team);
  // A request notification links /vault?s=sec-N, which opens here (lib/linkRoutes).
  const { s } = useLocalSearchParams<{ s?: string }>();
  const [openRef, setOpenRef] = useState<string | null>(s ?? null);
  const open = openRef ? rows.find((r) => r.short_id === openRef || r._id === openRef || r.name === openRef) : undefined;

  const requests = rows.filter((r) => r.status === 'requested');
  const ready = rows.filter((r) => r.status !== 'requested');
  const teamRows = ready.filter((r) => r.workspace === team);
  const mine = ready.filter((r) => r.workspace === personal);
  const openRow = (r: SecretMeta) => setOpenRef(r.short_id || r._id);

  return (
    <>
      <SettingsScroll>
        {requests.length > 0 && (
          <SettingsGroup title={`Requested · ${requests.length}`}>
            {requests.map((r) => <RequestCard key={r._id} row={r} onOpen={() => openRow(r)} />)}
          </SettingsGroup>
        )}
        {teamRows.length > 0 && (
          <SettingsGroup title={teamName ?? 'Team'}>
            {teamRows.map((r) => <SecretRow key={r._id} row={r} onPress={() => openRow(r)} />)}
          </SettingsGroup>
        )}
        {mine.length > 0 && (
          <SettingsGroup title="Only me">
            {mine.map((r) => <SecretRow key={r._id} row={r} onPress={() => openRow(r)} />)}
          </SettingsGroup>
        )}
        {rows.length === 0 && (
          <SettingsGroup>
            <RNView style={settingsStyles.row}>
              <RNText style={settingsStyles.muted}>No secrets</RNText>
            </RNView>
          </SettingsGroup>
        )}
      </SettingsScroll>
      <SecretSheet row={open} scope={open ? (open.workspace === personal ? 'Only me' : teamName ?? 'Team') : ''} onClose={() => setOpenRef(null)} />
    </>
  );
}

function SecretRow({ row, onPress }: { row: SecretMeta; onPress: () => void }) {
  const Theme = useTheme();
  const used = whereUsed(row);
  return (
    <TouchableOpacity style={settingsStyles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={row.name}>
      <KindGlyph kind={row.kind} />
      <RNView style={[settingsStyles.rowText, { marginLeft: Spacing.md }]}>
        <RNText style={settingsStyles.label} numberOfLines={1}>{row.name}</RNText>
        {used ? <RNText style={settingsStyles.description} numberOfLines={1}>{used}</RNText> : null}
      </RNView>
      <RNText style={[styles.when, !row.last_used_at && { color: Theme.textMuted0 }]}>
        {row.last_used_at ? formatRelativeTime(row.last_used_at) : 'unused'}
      </RNText>
    </TouchableOpacity>
  );
}

/** An open request: who asked and why, and the field that fills it. */
function RequestCard({ row, onOpen }: { row: SecretMeta; onOpen: () => void }) {
  const Theme = useTheme();
  const fulfill = useAction(api.secrets.fulfill);
  const stageSecret = useInboxStore((s) => s.stageSecret);
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkedPayload(row.kind, draft);
  const canSave = 'payload' in checked && !busy;
  const set = (field: keyof ValueDraft) => (v: string) => setDraft((d) => ({ ...d, [field]: v }));

  // The row flips to ready at once; a refusal puts the request back.
  const save = async () => {
    if (!('payload' in checked) || busy) return;
    setBusy(true);
    setError(null);
    stageSecret({ ...row, status: 'ready', updated_at: Date.now() });
    const res: any = await fulfill({ ref: row._id, payload: checked.payload }).catch((err: Error) => ({ error: err.message }));
    setBusy(false);
    if (res?.error) {
      stageSecret(row);
      setError(res.error);
      return;
    }
    setDraft(EMPTY_DRAFT);
  };

  const env = envFor(row).map((b) => b.var);
  return (
    <RNView style={styles.request}>
      <TouchableOpacity style={styles.requestHead} onPress={onOpen} activeOpacity={0.6}>
        <KindGlyph kind={row.kind} />
        <RNText style={[settingsStyles.label, { flex: 1 }]} numberOfLines={1}>{row.name}</RNText>
        <RNText style={styles.when}>{row.requested_by_name ?? ''}{row.requested_by_name ? ' · ' : ''}{formatRelativeTime(row.updated_at)}</RNText>
      </TouchableOpacity>
      {row.requested_from_conversation || row.request_why ? (
        <RNView style={styles.why}>
          {row.requested_from_conversation ? <EntityPill id={row.requested_from_conversation} type="session" /> : null}
          {row.request_why ? <RNText style={styles.whyText}>{row.request_why}</RNText> : null}
        </RNView>
      ) : null}
      {row.kind === 'signin' ? (
        <RNText style={settingsStyles.muted}>Save from a computer</RNText>
      ) : (
        <RNView style={{ gap: 6 }}>
          {row.kind === 'key' && (
            <SecretField value={draft.value} onChange={set('value')} placeholder={env[0] ?? 'Value'} onSubmit={save} />
          )}
          {row.kind === 'login' && (
            <>
              <SecretField value={draft.username} onChange={set('username')} placeholder="Username" plain contentType="username" />
              <SecretField value={draft.password} onChange={set('password')} placeholder="Password" contentType="password" />
              <SecretField value={draft.totp_seed} onChange={set('totp_seed')} placeholder="2FA seed (optional)" onSubmit={save} />
            </>
          )}
          {row.kind === 'file' && (
            <SecretField value={draft.content} onChange={set('content')} placeholder="File contents" plain multiline />
          )}
          <RNView style={styles.saveLine}>
            {error ? <RNText style={[styles.error, { color: Theme.red }]}>{error}</RNText> : <RNView style={{ flex: 1 }} />}
            <TouchableOpacity
              onPress={save}
              disabled={!canSave}
              style={[styles.save, { backgroundColor: canSave ? Theme.yellow : Theme.bgHighlight }]}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
            >
              <RNText style={[styles.saveText, { color: canSave ? Theme.bg : Theme.textMuted0 }]}>{busy ? 'Saving' : 'Save'}</RNText>
            </TouchableOpacity>
          </RNView>
        </RNView>
      )}
    </RNView>
  );
}

/** A value field, masked unless `plain`; the eye shows what was typed. */
function SecretField({ value, onChange, placeholder, plain, multiline, contentType, onSubmit }: {
  value: string; onChange: (v: string) => void; placeholder: string; plain?: boolean; multiline?: boolean;
  contentType?: 'username' | 'password'; onSubmit?: () => void;
}) {
  const Theme = useTheme();
  const [shown, setShown] = useState(false);
  const masked = !plain && !shown;
  return (
    <RNView style={styles.field}>
      <TextInput
        style={[styles.input, multiline && { minHeight: 72, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={Theme.textMuted0}
        secureTextEntry={masked}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textContentType={contentType ?? 'none'}
        autoComplete={contentType ?? 'off'}
        returnKeyType={onSubmit ? 'done' : 'next'}
        onSubmitEditing={onSubmit}
      />
      {!plain && (
        <TouchableOpacity onPress={() => setShown((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel={shown ? 'Hide' : 'Show'}>
          <Feather name={shown ? 'eye-off' : 'eye'} size={15} color={Theme.textMuted} />
        </TouchableOpacity>
      )}
    </RNView>
  );
}

/** A secret's metadata and its latest activity, in a sheet over the list. */
function SecretSheet({ row, scope, onClose }: { row: SecretMeta | undefined; scope: string; onClose: () => void }) {
  const Theme = useTheme();
  return (
    <Modal visible={!!row} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {row ? (
        <RNView style={styles.sheet}>
          <RNView style={styles.sheetHead}>
            <KindGlyph kind={row.kind} />
            <RNText style={styles.sheetTitle} numberOfLines={1}>{row.name}</RNText>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Close">
              <Feather name="x" size={20} color={Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <SettingsGroup>
              <Field label="Kind" value={row.status === 'requested' ? `${KIND[row.kind].label} · requested` : KIND[row.kind].label} />
              <Field label="Scope" value={scope} />
              {row.kind !== 'signin' && <Field label="Env" value={envFor(row).map((b) => b.var).join('\n')} />}
              {!!row.sites?.length && <Field label="Sites" value={row.sites.join('\n')} />}
              {!!row.note && <Field label="Note" value={row.note} />}
              {!!row.fingerprint && <Field label="Value" value={row.fingerprint} />}
              {!!row.signin_expires_at && <Field label="Expires" value={formatRelativeTime(row.signin_expires_at)} />}
              <Field label="Added" value={`${row.created_by_name ?? 'Someone'} · ${formatRelativeTime(row.created_at)}`} />
              {!!row.rotated_at && <Field label="Replaced" value={formatRelativeTime(row.rotated_at)} />}
              <Field
                label="Last used"
                value={row.last_used_at ? formatRelativeTime(row.last_used_at) : 'Never'}
                extra={row.last_used_by_conversation ? <EntityPill id={row.last_used_by_conversation} type="session" /> : null}
              />
              <Field label="Reads" value={String(row.use_count ?? 0)} />
            </SettingsGroup>
            <Activity row={row} />
          </ScrollView>
        </RNView>
      ) : null}
    </Modal>
  );
}

function Field({ label, value, extra }: { label: string; value: string; extra?: React.ReactNode }) {
  return (
    <RNView style={settingsStyles.row}>
      <RNText style={[settingsStyles.label, styles.fieldLabel]}>{label}</RNText>
      <RNView style={styles.fieldValue}>
        {extra}
        <RNText style={settingsStyles.detail} selectable>{value}</RNText>
      </RNView>
    </RNView>
  );
}

function Activity({ row }: { row: SecretMeta }) {
  const Theme = useTheme();
  const { data } = useQueryNoThrow(api.secrets.events, isStub(row) ? 'skip' : { ref: row._id });
  const events: any[] = Array.isArray(data) ? data : [];
  return (
    <SettingsGroup title="Activity">
      {events.length === 0 ? (
        <RNView style={settingsStyles.row}>
          <RNText style={settingsStyles.muted}>{data === undefined && !isStub(row) ? 'Loading' : 'Nothing yet'}</RNText>
        </RNView>
      ) : (
        events.map((e) => (
          <RNView key={e._id} style={styles.event}>
            <RNView style={[styles.dot, { backgroundColor: EVENT_TONE[e.kind] ? Theme[EVENT_TONE[e.kind]!] : Theme.textDim }]} />
            <RNView style={{ flex: 1, gap: 4 }}>
              <RNText style={styles.eventText}>
                {e.actor_name ?? 'Someone'} <RNText style={{ color: Theme.textMuted }}>{EVENT_VERB[e.kind] ?? e.kind}{e.purpose && e.kind === 'read' ? ` · ${e.purpose}` : ''}</RNText>
              </RNText>
              {e.conversation_id ? <EntityPill id={e.conversation_id} type="session" /> : null}
            </RNView>
            <RNText style={styles.when}>{formatRelativeTime(e.at)}</RNText>
          </RNView>
        ))
      )}
    </SettingsGroup>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  glyph: {
    width: 26,
    height: 26,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  when: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  request: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    gap: 8,
  },
  requestHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  why: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  whyText: {
    fontSize: 13,
    color: Theme.textSecondary,
    flexShrink: 1,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    paddingHorizontal: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 8,
  },
  saveLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  error: {
    flex: 1,
    fontSize: 12,
  },
  save: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  saveText: {
    fontSize: 14,
    fontWeight: '600',
  },
  sheet: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
  },
  sheetBody: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xxxl,
  },
  fieldLabel: {
    width: 90,
  },
  fieldValue: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
  },
  event: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
  },
  eventText: {
    fontSize: 14,
    color: Theme.text,
  },
}));
