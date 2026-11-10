import { useState, useRef, useCallback, useMemo, type MutableRefObject } from "react";
import { useQuery, useMutation } from "convex/react";
import { Bot, ChevronDown, ChevronLeft, FileText, Flag, Keyboard, Plug, Plus, Settings } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMountEffect } from "../hooks/useMountEffect";
import { desktopHeaderClass } from "../lib/desktop";
import { Button } from "./ui/button";

type ConfigFile = {
  path: string;
  type: string;
  label: string;
  tool: "claude" | "codex";
};

type SectionKey =
  | "global_claude"
  | "global_codex"
  | "agents"
  | "commands"
  | "skills"
  | "project";

type Section = {
  key: SectionKey;
  label: string;
  tool?: "claude" | "codex" | "both";
  files: ConfigFile[];
  canCreate?: boolean;
  createDir?: string;
};

const TYPE_ORDER: Record<string, number> = {
  instructions: 0,
  settings: 1,
  keybindings: 2,
  agent: 3,
  command: 4,
  skill: 5,
  prompt: 6,
  rules: 7,
  mcp: 8,
  project_instructions: 0,
  project_settings: 1,
  project_agent: 3,
  project_skill: 5,
  project_command: 4,
};

function groupFiles(files: ConfigFile[]): Section[] {
  const globalClaude = files.filter(
    (f) =>
      f.tool === "claude" &&
      !f.type.startsWith("project_") &&
      f.type !== "agent" &&
      f.type !== "command" &&
      f.type !== "skill" &&
      f.type !== "prompt"
  );
  const globalCodex = files.filter(
    (f) =>
      f.tool === "codex" &&
      !f.type.startsWith("project_") &&
      f.type !== "command" &&
      f.type !== "skill"
  );
  const agents = files.filter((f) => f.type === "agent");
  const claudeCommands = files.filter((f) => f.type === "command" && f.tool === "claude");
  const codexPrompts = files.filter((f) => (f.type === "command" || f.type === "prompt") && f.tool === "codex");
  const claudeSkills = files.filter((f) => f.type === "skill" && f.tool === "claude");
  const codexSkills = files.filter((f) => f.type === "skill" && f.tool === "codex");

  // Group project files by project name
  const projectFiles = files.filter((f) => f.type.startsWith("project_"));
  const projectMap = new Map<string, ConfigFile[]>();
  for (const f of projectFiles) {
    const proj = f.label.split("/")[0];
    if (!projectMap.has(proj)) projectMap.set(proj, []);
    projectMap.get(proj)!.push(f);
  }

  const sections: Section[] = [
    {
      key: "global_claude",
      label: "Claude Code — Global",
      tool: "claude",
      files: globalClaude.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)),
    },
    {
      key: "global_codex",
      label: "Codex — Global",
      tool: "codex",
      files: globalCodex.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)),
    },
    {
      key: "agents",
      label: "Agents",
      tool: "claude",
      files: agents,
      canCreate: true,
      createDir: "~/.claude/agents",
    },
    {
      key: "commands",
      label: "Commands",
      tool: "claude",
      files: claudeCommands,
      canCreate: true,
      createDir: "~/.claude/commands",
    },
    {
      key: "commands",
      label: "Prompts",
      tool: "codex",
      files: codexPrompts,
      canCreate: true,
      createDir: "~/.codex/prompts",
    },
    {
      key: "skills",
      label: "Skills",
      tool: "claude",
      files: claudeSkills,
      canCreate: true,
      createDir: "~/.claude/skills",
    },
    ...(codexSkills.length > 0 ? [{
      key: "skills" as SectionKey,
      label: "Skills (Codex)",
      tool: "codex" as const,
      files: codexSkills,
      canCreate: false,
    }] : []),
  ];

  for (const [proj, pfiles] of projectMap) {
    sections.push({
      key: `project` as SectionKey,
      label: proj,
      files: pfiles.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)),
    });
  }

  return sections.filter((s) => s.files.length > 0 || s.canCreate);
}

/** A daemon answer's JSON, or null with a toast when it is not JSON: a malformed answer never takes the page down. */
function parseAnswer<T>(raw: string | null | undefined, what: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    toast.error(`The daemon's answer to ${what} was not readable`);
    return null;
  }
}

/** Set by the open file while it holds unsaved edits: every way out of it (Back, another file, a new file) asks it
 *  first, and it offers Save / Discard instead of dropping the draft. Returns true when it held the exit. */
type LeaveGuard = MutableRefObject<((next: () => void) => boolean) | null>;

function ToolBadge({ tool }: { tool: "claude" | "codex" }) {
  return (
    <span
      className={`text-mark font-mono px-1.5 py-0.5 rounded uppercase tracking-wider border ${
        tool === "claude"
          ? "bg-sol-amber/10 text-sol-amber border-sol-amber/30"
          : "bg-sol-green/10 text-sol-green border-sol-green/30"
      }`}
    >
      {tool}
    </span>
  );
}

function useConfigCommand() {
  const sendCommand = useMutation(api.users.sendConfigCommand);
  const [commandId, setCommandId] = useState<Id<"daemon_commands"> | null>(null);
  const result = useQuery(
    api.users.getCommandResult,
    commandId ? { command_id: commandId } : "skip"
  );

  const send = useCallback(
    async (
      command: "config_list" | "config_read" | "config_write" | "config_create" | "config_delete",
      args?: object
    ) => {
      const res = await sendCommand({
        command,
        args_json: args ? JSON.stringify(args) : undefined,
      });
      setCommandId(res.command_id);
      return res.command_id;
    },
    [sendCommand]
  );

  const reset = useCallback(() => setCommandId(null), []);

  return { send, result, reset, commandId };
}

function FileEditor({
  file,
  onClose,
  leaveGuard,
}: {
  file: ConfigFile;
  onClose: () => void;
  leaveGuard: LeaveGuard;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // An exit taken while the draft was unsaved: it waits on Save, Discard or Keep editing.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The text a save sent: what is on disk once the daemon says it wrote, whatever was typed since.
  const sentRef = useRef<string | null>(null);
  // An exit that waited on a save, taken once the save lands.
  const afterSaveRef = useRef<(() => void) | null>(null);

  const readCmd = useConfigCommand();
  const writeCmd = useConfigCommand();

  // Load file on mount
  const hasLoadedRef = useRef(false);
  useWatchEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      readCmd.send("config_read", { file_path: file.path });
    }
  }, []);

  // Handle read result
  useWatchEffect(() => {
    if (!readCmd.result) return;
    if (readCmd.result.error) {
      toast.error(`Failed to read: ${readCmd.result.error}`);
      setLoading(false);
      return;
    }
    if (readCmd.result.executed_at) {
      const parsed = parseAnswer<{ content?: string | null }>(readCmd.result.result, "the read");
      const text = parsed?.content ?? "";
      setContent(text);
      setDraft(text);
      setLoading(false);
    }
  }, [readCmd.result]);

  // Handle write result
  useWatchEffect(() => {
    if (!writeCmd.result?.executed_at) return;
    setSaving(false);
    const then = afterSaveRef.current;
    afterSaveRef.current = null;
    if (writeCmd.result.error) {
      toast.error(`Failed to save: ${writeCmd.result.error}`);
    } else {
      setContent(sentRef.current);
      toast.success("Saved");
      if (then) {
        setLeaving(null);
        leaveGuard.current = null;
        then();
      }
    }
    writeCmd.reset();
  }, [writeCmd.result]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    sentRef.current = draft;
    await writeCmd.send("config_write", { file_path: file.path, content: draft });
  }, [draft, file.path, saving, writeCmd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = textareaRef.current!;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newVal = draft.substring(0, start) + "  " + draft.substring(end);
        setDraft(newVal);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [draft, handleSave]
  );

  const isDirty = !loading && draft !== content;
  // While the draft is unsaved, every exit the page offers comes here first.
  useWatchEffect(() => {
    leaveGuard.current = isDirty ? (next) => { setLeaving(() => next); return true; } : null;
    return () => { leaveGuard.current = null; };
  }, [isDirty, leaveGuard]);

  const ext = file.path.split(".").pop() ?? "md";
  const lang = ext === "json" ? "json" : ext === "toml" ? "toml" : "markdown";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="text-sol-text-dim hover:text-sol-text transition-colors"
          title="Back"
          aria-label="Back"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-sol-text truncate">{file.label}</span>
            <ToolBadge tool={file.tool} />
            <span className="text-mark font-mono text-sol-text-dim uppercase">{lang}</span>
            {isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-amber" title="Unsaved changes" />
            )}
          </div>
          <div className="text-meta font-mono text-sol-text-dim truncate mt-0.5">{file.path}</div>
        </div>
        {leaving ? (
          <div className="flex shrink-0 items-center gap-2" role="group" aria-label="Unsaved changes">
            <span className="text-xs text-sol-orange">Unsaved changes</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setLeaving(null)} autoFocus>Keep editing</Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => { const next = leaving; setLeaving(null); leaveGuard.current = null; next(); }}>Discard</Button>
            <Button type="button" variant="secondary" size="xs" disabled={saving} onClick={() => { afterSaveRef.current = leaving; void handleSave(); }}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" size="xs" onClick={handleSave} disabled={!isDirty || saving || loading}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden relative">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sol-text-dim font-mono text-sm animate-pulse">Loading…</span>
          </div>
        ) : (
          <div className="flex h-full">
            {/* Line numbers */}
            <LineNumbers content={draft} />
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              className="flex-1 resize-none bg-transparent outline-none font-mono text-[13px] leading-6 text-sol-text py-4 pr-4 pl-3"
              style={{ tabSize: 2 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LineNumbers({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div
      aria-hidden
      className="select-none py-4 pl-4 pr-3 text-right font-mono text-[13px] leading-6 text-sol-text-dim shrink-0 min-w-[3rem]"
    >
      {lines.map((_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

function NewFileModal({
  dir,
  tool,
  onClose,
  onCreated,
}: {
  dir: string;
  tool: "claude" | "codex";
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const createCmd = useConfigCommand();

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    const filename = name.trim().endsWith(".md") ? name.trim() : `${name.trim()}.md`;
    await createCmd.send("config_create", {
      dir_path: dir,
      filename,
      content: `---\nname: "${name.trim()}"\ndescription: ""\n---\n\n`,
    });
  };

  useWatchEffect(() => {
    if (!createCmd.result?.executed_at) return;
    setCreating(false);
    if (createCmd.result.error) {
      toast.error(`Failed to create: ${createCmd.result.error}`);
    } else {
      const parsed = parseAnswer<{ path?: string }>(createCmd.result.result, "the create");
      if (parsed?.path) onCreated(parsed.path);
      onClose();
    }
  }, [createCmd.result]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-sol-bg border border-sol-border rounded-lg p-5 w-80 max-w-[calc(100vw-2rem)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-sol-text mb-1">New file</div>
        <div className="text-meta font-mono text-sol-text-dim mb-4 truncate" title={dir}>{dir}</div>
        <input
          autoFocus
          type="text"
          placeholder="File name"
          aria-label="File name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
            if (e.key === "Escape") onClose();
          }}
          className="w-full px-3 py-2 bg-sol-bg-alt border border-sol-border rounded text-sm font-mono text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
        />
        <div className="flex gap-2 mt-3">
          <Button type="button" variant="ghost" size="xs" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="secondary" size="xs" className="flex-1" onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConfigEditor() {
  const [selectedFile, setSelectedFile] = useState<ConfigFile | null>(null);
  const [allFiles, setAllFiles] = useState<ConfigFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newFileDir, setNewFileDir] = useState<{ dir: string; tool: "claude" | "codex" } | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["global_claude", "global_codex", "agents", "commands", "skills"])
  );
  // Every way out of the open file asks it first (LeaveGuard).
  const leaveGuard: LeaveGuard = useRef<((next: () => void) => boolean) | null>(null);
  const guarded = (next: () => void) => {
    if (!leaveGuard.current?.(next)) next();
  };

  const [deskClass, setDeskClass] = useState("");
  useMountEffect(() => { setDeskClass(desktopHeaderClass()); });
  const sentPathsRef = useRef<string | null>(null);
  const listCmd = useConfigCommand();
  const projects = useQuery(api.projects.webList, {});
  // Local-first: the persisted projects collection usually already holds the
  // roster, so the config_list command goes out immediately instead of
  // waiting a round-trip. Keyed on the PATH SET, not a sent-once flag: if the
  // live answer later carries a different set (a project added since the
  // cache), the command re-runs and the listing self-corrects.
  const cachedProjects = useInboxStore((s) => s.projects);
  const projectRows = useMemo(() => {
    if (projects !== undefined) return projects;
    const rows = Object.values(cachedProjects ?? {});
    return rows.length > 0 ? rows : undefined;
  }, [projects, cachedProjects]);

  useWatchEffect(() => {
    if (projectRows === undefined) return;
    const projectPaths = (projectRows as any[])
      .map((p: any) => p.project_path)
      .filter(Boolean)
      .sort() as string[];
    const sig = projectPaths.join("|");
    if (sentPathsRef.current === sig) return;
    sentPathsRef.current = sig;
    listCmd.send("config_list", { project_paths: projectPaths });
  }, [projectRows]);

  // Handle list result
  useWatchEffect(() => {
    if (!listCmd.result?.executed_at) return;
    if (listCmd.result.error) {
      setLoadError(listCmd.result.error);
      return;
    }
    if (listCmd.result.result) {
      const files = parseAnswer<ConfigFile[]>(listCmd.result.result, "the file list");
      if (files) setAllFiles(files);
    }
  }, [listCmd.result]);

  const sections = allFiles ? groupFiles(allFiles) : [];

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleFileCreated = (path: string) => {
    // Refresh the file list (sent directly, so the path-set guard on the
    // initial send doesn't apply).
    const projectPaths = ((projectRows ?? []) as any[])
      .map((p: any) => p.project_path)
      .filter(Boolean) as string[];
    listCmd.send("config_list", { project_paths: projectPaths });
    // Select the new file
    const label = path.split("/").pop() ?? path;
    const tool = path.includes("/.claude/") || path.includes("/.codex/prompts")
      ? path.includes(".codex") ? "codex" : "claude"
      : "claude";
    guarded(() => setSelectedFile({ path, type: "agent", label: label.replace(/\.md$/, ""), tool }));
  };

  return (
    <div className="flex h-full min-h-0 bg-sol-bg text-sol-text">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-sol-border flex flex-col overflow-hidden">
        <div className={`px-4 py-4 border-b border-sol-border flex items-center gap-3 ${deskClass}`}>
          <span className="text-sm font-medium text-sol-text">Config</span>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {allFiles === null && !loadError && (
            <div className="px-4 py-8 text-center">
              <span className="text-sol-text-dim font-mono text-xs animate-pulse">
                {listCmd.commandId && !listCmd.result ? "Waiting for the daemon…" : "Loading…"}
              </span>
            </div>
          )}

          {loadError && (
            <div className="px-4 py-4 text-xs text-sol-red font-mono break-words">{loadError}</div>
          )}

          {sections.map((section) => {
            const sectionId = `${section.key}-${section.label}`;
            const isExpanded = expandedSections.has(sectionId) || expandedSections.has(section.key);

            return (
              <div key={sectionId} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleSection(sectionId)}
                  aria-expanded={isExpanded}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-sol-bg-alt transition-colors group"
                >
                  <ChevronDown aria-hidden className={`w-3 h-3 text-sol-text-dim transition-transform shrink-0 ${isExpanded ? "" : "-rotate-90"}`} />
                  <span className="text-mark font-mono uppercase tracking-wider text-sol-text-muted flex-1 truncate">
                    {section.label}
                  </span>
                  {section.tool && section.tool !== "both" && (
                    <ToolBadge tool={section.tool} />
                  )}
                </button>

                {isExpanded && (
                  <div className="ml-3 mb-1">
                    {section.files.map((file) => {
                      const isActive = selectedFile?.path === file.path;
                      return (
                        <button
                          type="button"
                          key={file.path}
                          onClick={() => { if (!isActive) guarded(() => setSelectedFile(file)); }}
                          aria-current={isActive ? "true" : undefined}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md mx-1 transition-colors ${
                            isActive
                              ? "bg-sol-bg-highlight text-sol-text"
                              : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
                          }`}
                        >
                          <FileIcon type={file.type} />
                          <span className="text-[12px] font-mono truncate flex-1">
                            {file.label.includes("/")
                              ? file.label.split("/").slice(1).join("/")
                              : file.label}
                          </span>
                          {file.tool === "codex" && (
                            <span className="text-meta font-mono text-sol-green shrink-0">cx</span>
                          )}
                        </button>
                      );
                    })}

                    {section.canCreate && section.createDir && (
                      <button
                        type="button"
                        onClick={() =>
                          setNewFileDir({
                            dir: section.createDir!,
                            tool: section.tool === "codex" ? "codex" : "claude",
                          })
                        }
                        className="w-full flex items-center gap-2 px-3 py-1.5 mx-1 text-left rounded-md text-sol-text-dim hover:text-sol-text transition-colors"
                      >
                        <Plus aria-hidden className="w-3 h-3" />
                        <span className="text-meta font-mono">New</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 overflow-hidden">
        {selectedFile ? (
          <FileEditor
            key={selectedFile.path}
            file={selectedFile}
            onClose={() => guarded(() => setSelectedFile(null))}
            leaveGuard={leaveGuard}
          />
        ) : (
          <EmptyEditor />
        )}
      </main>

      {/* New file modal */}
      {newFileDir && (
        <NewFileModal
          dir={newFileDir.dir}
          tool={newFileDir.tool}
          onClose={() => setNewFileDir(null)}
          onCreated={handleFileCreated}
        />
      )}
    </div>
  );
}

/** The file's kind, as an icon beside its name. */
function FileIcon({ type }: { type: string }) {
  const Icon =
    type === "agent" || type === "project_agent" ? Bot
    : type === "settings" || type === "project_settings" ? Settings
    : type === "keybindings" ? Keyboard
    : type === "mcp" ? Plug
    : type === "rules" ? Flag
    : FileText;
  return <Icon aria-hidden className="w-3 h-3 shrink-0 text-sol-text-dim" />;
}

function EmptyEditor() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="w-12 h-12 rounded-xl bg-sol-bg-alt border border-sol-border flex items-center justify-center mb-4">
        <FileText aria-hidden className="w-6 h-6 text-sol-text-dim" strokeWidth={1.5} />
      </div>
      <p className="text-sol-text-muted text-sm">Select a file to edit</p>
      <p className="text-sol-text-dim text-xs mt-1 font-mono">CLAUDE.md · AGENTS.md · settings.json · agents · commands</p>
    </div>
  );
}
