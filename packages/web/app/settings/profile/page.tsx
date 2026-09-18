import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import {
  Activity, Globe, LayoutList, Monitor, MonitorDot, Palette, User, Volume2,
} from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isDesktop, getAppVersion, checkDesktopUpdate } from "../../../lib/desktop";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { Switch } from "../../../components/ui/switch";
import { SelectBox } from "../../../components/ui/select-box";
import { useInboxStore, resolveSimpleView, resolveInboxCompact, type ClientUI } from "../../../store/inboxStore";
import { BUBBLE_HUE_VAR, BUBBLE_PRESETS, DEFAULT_BUBBLE_PRESET, isCustomBubbleColor, resolveBubbleHue } from "../../../lib/bubbleColor";
import { useTheme, type VisualStyle } from "../../../components/ThemeProvider";
import {
  SettingsField, SettingsLinkRow, SettingsOptionGroup, SettingsPanel, SettingsRow, SettingsSection,
} from "../../../components/settings/ui";

export default function ProfilePage() {
  const { user } = useCurrentUser();
  if (!user) return null;
  return (
    <SettingsPanel>
      <ProfileSection key={user._id} user={user} />
      <AppearanceSection />
      <InterfaceSection />
      <DesktopSection />
      <DaemonSection user={user} />
      <PublicProfileSection user={user} />
    </SettingsPanel>
  );
}

// ── profile ────────────────────────────────────────────────────────────────

/** The identity form. Fields hold the CURRENT values and save what changed —
 *  the old form showed placeholders, cleared itself on save, and echoed the
 *  real value only as hint text below each input. */
function ProfileSection({ user }: { user: any }) {
  const updateProfile = useMutation(api.users.updateProfile);
  const [form, setForm] = useState({
    name: user.name ?? "", bio: user.bio ?? "", title: user.title ?? "",
    status: user.status ?? "available", timezone: user.timezone ?? "",
  });
  const [isSaving, setIsSaving] = useState(false);

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const dirty =
    form.name !== (user.name ?? "") ||
    form.bio !== (user.bio ?? "") ||
    form.title !== (user.title ?? "") ||
    form.status !== (user.status ?? "available") ||
    form.timezone !== (user.timezone ?? "");

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Send empty strings too — clearing a field is a real edit, and
      // updateProfile only skips fields that are undefined.
      await updateProfile({
        name: form.name,
        bio: form.bio,
        title: form.title,
        status: form.status as "available" | "busy" | "away",
        timezone: form.timezone,
      });
      toast.success("Profile saved");
    } catch {
      toast.error("Could not save profile");
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass = "bg-sol-bg border-sol-border text-sol-text";
  return (
    <SettingsSection title="Profile" icon={User} description="How you appear to your team.">
      <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x divide-sol-border/40">
        <SettingsField label="Display name" htmlFor="name">
          <Input id="name" value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="Your name" className={inputClass} />
        </SettingsField>
        <SettingsField label="Title / role" htmlFor="title">
          <Input id="title" value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="e.g. Senior Developer" className={inputClass} />
        </SettingsField>
      </div>
      <SettingsField label="Bio" htmlFor="bio">
        <Textarea id="bio" rows={2} value={form.bio} onChange={(e) => set("bio")(e.target.value)} placeholder="A line about yourself" className={inputClass} />
      </SettingsField>
      <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x divide-sol-border/40">
        <SettingsField label="Status" htmlFor="status">
          {/* Sized to sit beside the Input fields: same height, text size and surface. */}
          <SelectBox id="status" value={form.status} onChange={(e) => set("status")(e.target.value)} wrapperClassName="w-full" className="h-9 rounded-md bg-sol-bg text-sm">
            <option value="available">Available</option>
            <option value="busy">Busy</option>
            <option value="away">Away</option>
          </SelectBox>
        </SettingsField>
        <SettingsField label="Timezone" htmlFor="timezone">
          <Input id="timezone" value={form.timezone} onChange={(e) => set("timezone")(e.target.value)} placeholder="e.g. America/Los_Angeles" className={inputClass} />
        </SettingsField>
      </div>
      <SettingsRow
        label={<span className="text-xs text-sol-text-muted">Signed in as {user.email}{user.github_username ? ` · @${user.github_username}` : ""}</span>}
      >
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || isSaving}
          variant="cyan"
        >
          {isSaving ? "Saving…" : "Save changes"}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

// ── interface preferences ──────────────────────────────────────────────────

function AppearanceSection() {
  const { visualStyle, setVisualStyle } = useTheme();
  const options = ([
    { value: "classic", label: "Classic", description: <StyleOptionPreview variant="classic" caption="Solarized, compact, information-dense" /> },
    { value: "minimal", label: "Minimal", description: <StyleOptionPreview variant="minimal" caption="Neutral, spacious, reading-first" /> },
  ] satisfies Array<{ value: VisualStyle; label: string; description: ReactNode }>);
  return (
    <SettingsSection title="Appearance" icon={Palette} description="Choose the visual language for every Codecast surface.">
      <SettingsField
        label="Interface style"
        hint="Minimal is quieter and more spacious, with neutral surfaces and a focused reading column."
      >
        <SettingsOptionGroup
          value={visualStyle}
          onChange={(value) => setVisualStyle(value as VisualStyle)}
          label="Interface style"
          options={options}
          className="visual-style-options w-full"
        />
      </SettingsField>
      {visualStyle === "minimal" && <BubbleColorField />}
    </SettingsSection>
  );
}

/** The color of your own messages in Minimal: a row of swatches, the last one
 *  a native color well for anything else. The sample bubble beside the label is
 *  painted by the same stylesheet variable the conversation uses, so what you
 *  pick here is what you read there. */
function BubbleColorField() {
  const stored = useInboxStore((s) => s.clientState?.ui?.user_bubble_color);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  const custom = isCustomBubbleColor(stored);
  const activePreset = custom ? null : (BUBBLE_PRESETS.find((p) => p.id === stored)?.id ?? DEFAULT_BUBBLE_PRESET);
  return (
    <SettingsField label="Your message color" hint="The bubble behind the messages you send. It follows you to every device.">
      <div className="cc-bubble-scope flex flex-wrap items-center gap-x-5 gap-y-3">
        <div role="radiogroup" aria-label="Your message color" className="flex items-center gap-2">
          {BUBBLE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={activePreset === p.id}
              aria-label={p.label}
              title={p.label}
              onClick={() => updateUI({ user_bubble_color: p.id })}
              className="cc-bubble-swatch"
              style={{ "--swatch": p.hue } as CSSProperties}
            />
          ))}
          <label className="cc-bubble-swatch cc-bubble-swatch--custom" data-checked={custom ? "" : undefined} title="Custom color" style={custom ? ({ "--swatch": resolveBubbleHue(stored) } as CSSProperties) : undefined}>
            <span className="sr-only">Custom color</span>
            {/* A color well fires `input` for every pixel of a drag and `change`
                once when it closes. The drag previews on this field alone
                (.cc-bubble-scope mixes its own fill), so a pick that is
                cancelled leaves the app untouched; only `change` is a
                preference write, and it clears the preview. */}
            <input
              type="color"
              defaultValue={resolveBubbleHue(stored)}
              key={resolveBubbleHue(stored)}
              onInput={(e) => e.currentTarget.closest<HTMLElement>(".cc-bubble-scope")?.style.setProperty(BUBBLE_HUE_VAR, e.currentTarget.value)}
              onBlur={(e) => e.currentTarget.closest<HTMLElement>(".cc-bubble-scope")?.style.removeProperty(BUBBLE_HUE_VAR)}
              ref={(el) => {
                if (!el) return;
                const commit = () => {
                  el.closest<HTMLElement>(".cc-bubble-scope")?.style.removeProperty(BUBBLE_HUE_VAR);
                  updateUI({ user_bubble_color: el.value });
                };
                el.addEventListener("change", commit);
                return () => el.removeEventListener("change", commit);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
        <span aria-hidden className="cc-bubble-sample">Sounds good, ship it</span>
      </div>
    </SettingsField>
  );
}

function StyleOptionPreview({ variant, caption }: { variant: VisualStyle; caption: string }) {
  return (
    <span className="mt-2 block">
      <span aria-hidden="true" className={`cc-style-preview cc-style-preview--${variant}`}>
        <span className="cc-style-preview__nav"><i /><i /><i /></span>
        <span className="cc-style-preview__body"><i /><i /><i /></span>
        <span className="cc-style-preview__rail"><i /><i /></span>
      </span>
      <span className="mt-1.5 block">{caption}</span>
    </span>
  );
}

const INTERFACE_TOGGLES: Array<{
  prefKey: keyof ClientUI;
  label: string;
  desc: string;
  /** Keys that default ON read `!== false`; default-OFF keys read `=== true`. */
  defaultOn?: boolean;
  /** The preference is decided elsewhere right now: the row shows ON, cannot be
   *  switched, and says why. The stored value is kept for when that ends. */
  lockedOn?: (ui: ClientUI | undefined) => string | undefined;
  /** The value when it is not a plain stored boolean (a default that depends
   *  on the style). Overrides `defaultOn`. */
  resolve?: (ui: ClientUI | undefined) => boolean;
}> = [
  { prefKey: "simple_view", label: "Simple view", desc: "Calmer conversations and inbox cards — secondary badges, counts and meta rows drop away", defaultOn: true, lockedOn: (ui) => (ui?.visual_style === "minimal" && resolveSimpleView(ui) ? "Always on in the Minimal style" : undefined) },
  { prefKey: "inbox_compact", label: "Compact session list", desc: "One line per session in the inbox: the title, its state and when it last moved. Works in every style, and is how Minimal lists sessions unless you turn it off", resolve: resolveInboxCompact },
  { prefKey: "inbox_image_thumbs", label: "Image thumbnails", desc: "Show a small thumbnail on inbox session rows when a session contains images" },
  { prefKey: "show_agent_icon", label: "Agent icon", desc: "Show each session's agent client (Claude Code, opencode, …) next to its title in the inbox", defaultOn: true },
  { prefKey: "personify_sessions", label: "Personify every session", desc: "Give every session an animal face and a name, not just the ones you name yourself. Roles always have one", defaultOn: false },
  { prefKey: "show_model_badge", label: "Model badge", desc: "Show each session's model in the inbox session list" },
  { prefKey: "comments_enabled", label: "Comments", desc: "Show the tools to leave comments on conversations. You can always read and reply to comments others leave, even with this off." },
  { prefKey: "auto_open_browser_panes", label: "Open agent pane offers", desc: "When an agent offers a page (cast browser pane), open it beside the conversation you are reading instead of waiting for a click" },
  { prefKey: "composer_suggestions", label: "Suggested replies", desc: "One-tap reply suggestions above the composer when a session waits on you, predicted from the session and how you usually reply" },
];

function InterfaceSection() {
  return (
    <SettingsSection title="Interface" icon={LayoutList} description="What the inbox and conversations show.">
      {INTERFACE_TOGGLES.map((t) => (
        <PrefToggleRow key={t.prefKey} {...t} />
      ))}
      <SoundsLinkRow />
    </SettingsSection>
  );
}

function PrefToggleRow(t: (typeof INTERFACE_TOGGLES)[number]) {
  const enabled = useInboxStore((s) => {
    if (t.resolve) return t.resolve(s.clientState?.ui);
    const v = s.clientState?.ui?.[t.prefKey];
    return t.defaultOn ? v !== false : v === true;
  });
  const locked = useInboxStore((s) => t.lockedOn?.(s.clientState?.ui));
  const updateUI = useInboxStore((s) => s.updateClientUI);
  return (
    <SettingsRow label={t.label} description={locked ? `${t.desc}. ${locked}.` : t.desc} disabled={!!locked}>
      <Switch checked={enabled || !!locked} disabled={!!locked} onCheckedChange={(v) => updateUI({ [t.prefKey]: v } as Partial<ClientUI>)} aria-label={t.label} />
    </SettingsRow>
  );
}

function SoundsLinkRow() {
  const soundsOn = useInboxStore((s) => s.clientState?.ui?.sounds_enabled !== false);
  return (
    <SettingsLinkRow
      icon={Volume2}
      label="Sounds"
      description="Volume and per-event sound controls"
      value={soundsOn ? "On" : "Off"}
      onClick={() => useInboxStore.getState().openSettingsModal("sounds")}
    />
  );
}

// ── desktop ────────────────────────────────────────────────────────────────

/** Version readout + the link-handoff opt-in; the whole section renders only
 *  where it means something. The "Update now" action lives in the global
 *  banner (DesktopProvider); here it's a passive at-a-glance readout. */
function DesktopSection() {
  const [current, setCurrent] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  const hasUsedDesktop = useInboxStore((s) => s.clientState?.dismissed?.has_used_desktop === true);
  const preferBrowser = useInboxStore((s) => s.clientState?.dismissed?.prefer_browser_links === true);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);

  useMountEffect(() => {
    if (!isDesktop()) return;
    getAppVersion().then(setCurrent);
    checkDesktopUpdate().then(setUpdate);
  });

  const inDesktop = isDesktop() && !!current;
  if (!inDesktop && !hasUsedDesktop) return null;

  return (
    <SettingsSection title="Desktop" icon={Monitor}>
      {inDesktop && (
        <SettingsRow
          label="Desktop app"
          description={update ? `Version ${current} — v${update.latest} available` : `Version ${current} — up to date`}
        >
          {update && (
            <span className="rounded-md bg-sol-cyan/15 px-2 py-0.5 text-[11px] text-sol-cyan">Update available</span>
          )}
        </SettingsRow>
      )}
      {/* Inverse of the sticky "Always open Codecast links in browser" opt-out
          from OpenInDesktopHandoff — the only place to turn the handoff back on. */}
      {hasUsedDesktop && (
        <SettingsRow
          label="Open links in desktop app"
          description="Hand off codecast.sh pages from the browser to the desktop app"
        >
          <Switch
            checked={!preferBrowser}
            onCheckedChange={(v) => updateDismissed("prefer_browser_links", !v)}
            aria-label="Open links in desktop app"
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

// ── daemon ─────────────────────────────────────────────────────────────────

function relativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "Never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function DaemonSection({ user }: { user: any }) {
  const connected = user.daemon_last_seen && Date.now() - user.daemon_last_seen < 60000;
  return (
    <SettingsSection title="Daemon" icon={Activity} description="The background process that connects your machines.">
      <SettingsRow label="Status">
        <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${connected ? "text-sol-green" : "text-sol-orange"}`}>
          <MonitorDot className="h-3.5 w-3.5" />
          {connected ? "Connected" : "Not connected"}
        </span>
      </SettingsRow>
      <SettingsRow label="Last seen">
        {user.daemon_last_seen ? `${relativeTime(user.daemon_last_seen)} · ${new Date(user.daemon_last_seen).toLocaleString()}` : "Never"}
      </SettingsRow>
    </SettingsSection>
  );
}

// ── public profile ─────────────────────────────────────────────────────────

// Claim a handle + flip the master public-profile switch. The handle is the
// public URL, so enabling is gated on having claimed one (the mutation enforces
// this too). Availability is checked live as you type via isUsernameAvailable.
function PublicProfileSection({ user }: { user: any }) {
  const claimUsername = useMutation(api.users.claimUsername);
  const setEnabled = useMutation(api.users.setPublicProfileEnabled);

  const [handle, setHandle] = useState<string>(user.username || "");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = handle.trim().toLowerCase();
  const dirty = trimmed !== (user.username || "");
  // Only probe availability for a changed, non-trivial candidate.
  const check = useQuery(
    api.users.isUsernameAvailable,
    dirty && trimmed.length >= 3 ? { username: trimmed } : "skip"
  );
  const suggestion = user.github_username && !user.username ? user.github_username.toLowerCase() : null;

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      await claimUsername({ username: trimmed });
    } catch (e: any) {
      setError(e?.message?.replace(/^.*Error:\s*/, "") || "Could not claim username");
    } finally {
      setClaiming(false);
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canEnable = !!user.username;

  return (
    <SettingsSection
      title="Public profile"
      icon={Globe}
      description={
        <>
          When on, anyone can view <span className="font-mono text-sol-text-muted">{origin}/{user.username || "your-handle"}</span> —
          your identity, an anonymized activity graph, and the sessions you&apos;ve pinned. Off by default;
          nothing is public until you turn this on.
        </>
      }
      actions={
        <Switch
          checked={!!user.public_profile_enabled}
          disabled={!canEnable}
          onCheckedChange={(v) => setEnabled({ enabled: v }).catch(() => {})}
          aria-label="Public profile"
        />
      }
    >
      <SettingsField
        label="Username"
        htmlFor="handle"
        hint={
          error ? (
            <span className="text-sol-red">{error}</span>
          ) : suggestion && !user.username && !dirty ? (
            <button onClick={() => setHandle(suggestion)} className="text-sol-cyan hover:underline">
              Use @{suggestion} from GitHub
            </button>
          ) : dirty && trimmed.length >= 3 && check ? (
            check.available ? (
              <span className="text-sol-green">@{trimmed} is available</span>
            ) : (
              <span className="text-sol-orange">{check.reason}</span>
            )
          ) : user.username ? (
            <span>
              Your profile lives at{" "}
              <a href={`/${user.username}`} target="_blank" rel="noreferrer" className="text-sol-cyan hover:underline">
                /{user.username}
              </a>
            </span>
          ) : (
            "Claim a username to enable your public profile."
          )
        }
      >
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center rounded-md border border-sol-border bg-sol-bg px-2 focus-within:border-sol-cyan/50">
            <span className="select-none text-sm text-sol-text-dim">/</span>
            <Input
              id="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={suggestion || "your-handle"}
              className="border-0 bg-transparent px-1 focus-visible:ring-0"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <Button
            size="sm"
            onClick={handleClaim}
            disabled={!dirty || claiming || trimmed.length < 3 || (check && !check.available)}
            variant="cyan"
          >
            {claiming ? "Saving…" : user.username ? "Update" : "Claim"}
          </Button>
        </div>
      </SettingsField>
    </SettingsSection>
  );
}
