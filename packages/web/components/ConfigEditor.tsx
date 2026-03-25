import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import Link from "next/link";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMountEffect } from "../hooks/useMountEffect";
import { desktopHeaderClass } from "../lib/desktop";

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

function ToolBadge({ tool }: { tool: "claude" | "codex" }) {
  return (
    <span
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${
        tool === "claude"
          ? "bg-amber-950/50 text-amber-400 border border-amber-900/40"
          : "bg-emerald-950/50 text-emerald-400 border border-emerald-900/40"
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
}: {
  file: ConfigFile;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      const parsed = readCmd.result.result ? JSON.parse(readCmd.result.result) : null;
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
    if (writeCmd.result.error) {
      toast.error(`Failed to save: ${writeCmd.result.error}`);
    } else {
      setContent(draft);
      toast.success("Saved");
    }
    writeCmd.reset();
  }, [writeCmd.result]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
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

  const isDirty = draft !== content;
  const ext = file.path.split(".").pop() ?? "md";
  const lang = ext === "json" ? "json" : ext === "toml" ? "toml" : "markdown";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
        <button
          onClick={onClose}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
          title="Back"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-zinc-200 truncate">{file.label}</span>
            <ToolBadge tool={file.tool} />
            <span className="text-[10px] font-mono text-zinc-600 uppercase">{lang}</span>
            {isDirty && !loading && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
            )}
          </div>
          <div className="text-[11px] font-mono text-zinc-600 truncate mt-0.5">{file.path}</div>
        </div>
        <button
          onClick={handleSave}
          disabled={!isDirty || saving || loading}
          className="px-3 py-1.5 text-xs font-mono rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white bg-zinc-900"
        >
          {saving ? "saving..." : "save"}
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden relative">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-zinc-600 font-mono text-sm animate-pulse">loading...</span>
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
              className="flex-1 resize-none bg-transparent outline-none font-mono text-[13px] leading-6 text-zinc-200 py-4 pr-4 pl-3"
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
      className="select-none py-4 pl-4 pr-3 text-right font-mono text-[13px] leading-6 text-zinc-700 shrink-0 min-w-[3rem]"
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

  const home =
    typeof window !== "undefined" ? "" : "";
  const resolvedDir = dir.startsWith("~/")
    ? dir
    : dir;

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    const filename = name.trim().endsWith(".md") ? name.trim() : `${name.trim()}.md`;
    await createCmd.send("config_create", {
      dir_path: resolvedDir,
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
      const parsed = createCmd.result.result ? JSON.parse(createCmd.result.result) : null;
      if (parsed?.path) onCreated(parsed.path);
      onClose();
    }
  }, [createCmd.result]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-80 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-mono text-zinc-300 mb-1">New file</div>
        <div className="text-[11px] font-mono text-zinc-600 mb-4">{dir}</div>
        <input
          autoFocus
          type="text"
          placeholder="filename (without .md)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
            if (e.key === "Escape") onClose();
          }}
          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
        <div className="flex gap-2 mt-3">
          <button
            onClick={onClose}
            className="flex-1 py-1.5 text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="flex-1 py-1.5 text-xs font-mono bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded transition-colors disabled:opacity-40"
          >
            {creating ? "creating..." : "create"}
          </button>
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

  const [deskClass, setDeskClass] = useState("");
  useMountEffect(() => { setDeskClass(desktopHeaderClass()); });

  const listCmd = useConfigCommand();
  const projects = useQuery(api.projects.webList, {});

  // Send config_list when projects are loaded
  const sentRef = useRef(false);
  const prevProjects = useRef<typeof projects>(undefined);
  useWatchEffect(() => {
    if (projects === undefined) return;
    if (sentRef.current && prevProjects.current !== undefined) return;
    sentRef.current = true;
    prevProjects.current = projects;
    const projectPaths = (projects ?? [])
      .map((p: any) => p.project_path)
      .filter(Boolean) as string[];
    listCmd.send("config_list", { project_paths: projectPaths });
  }, [projects]);

  // Handle list result
  useWatchEffect(() => {
    if (!listCmd.result?.executed_at) return;
    if (listCmd.result.error) {
      setLoadError(listCmd.result.error);
      return;
    }
    if (listCmd.result.result) {
      const files: ConfigFile[] = JSON.parse(listCmd.result.result);
      setAllFiles(files);
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
    // Refresh the file list
    sentRef.current = false;
    const projectPaths = (projects ?? [])
      .map((p: any) => p.project_path)
      .filter(Boolean) as string[];
    listCmd.send("config_list", { project_paths: projectPaths });
    // Select the new file
    const label = path.split("/").pop() ?? path;
    const tool = path.includes("/.claude/") || path.includes("/.codex/prompts")
      ? path.includes(".codex") ? "codex" : "claude"
      : "claude";
    setSelectedFile({ path, type: "agent", label: label.replace(/\.md$/, ""), tool });
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-zinc-800 flex flex-col overflow-hidden">
        <div className={`px-4 py-4 border-b border-zinc-800 flex items-center gap-3 ${deskClass}`}>
          <Link href="/inbox" className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <span className="text-sm font-medium text-zinc-300">Config</span>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {allFiles === null && !loadError && (
            <div className="px-4 py-8 text-center">
              {listCmd.commandId && !listCmd.result ? (
                <span className="text-zinc-600 font-mono text-xs animate-pulse">
                  waiting for daemon...
                </span>
              ) : (
                <span className="text-zinc-600 font-mono text-xs animate-pulse">loading...</span>
              )}
            </div>
          )}

          {loadError && (
            <div className="px-4 py-4 text-xs text-red-400 font-mono">{loadError}</div>
          )}

          {sections.map((section) => {
            const sectionId = `${section.key}-${section.label}`;
            const isExpanded = expandedSections.has(sectionId) || expandedSections.has(section.key);

            return (
              <div key={sectionId} className="mb-1">
                <button
                  onClick={() => toggleSection(sectionId)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/40 transition-colors group"
                >
                  <svg
                    className={`w-3 h-3 text-zinc-600 transition-transform shrink-0 ${isExpanded ? "" : "-rotate-90"}`}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                  </svg>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 flex-1 truncate">
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
                          key={file.path}
                          onClick={() => setSelectedFile(file)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md mx-1 transition-colors ${
                            isActive
                              ? "bg-zinc-800 text-zinc-100"
                              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                          }`}
                        >
                          <FileIcon type={file.type} tool={file.tool} />
                          <span className="text-[12px] font-mono truncate flex-1">
                            {file.label.includes("/")
                              ? file.label.split("/").slice(1).join("/")
                              : file.label}
                          </span>
                          {file.tool === "codex" && (
                            <span className="text-[9px] font-mono text-emerald-700 shrink-0">cx</span>
                          )}
                        </button>
                      );
                    })}

                    {section.canCreate && section.createDir && (
                      <button
                        onClick={() =>
                          setNewFileDir({
                            dir: section.createDir!,
                            tool: section.tool === "codex" ? "codex" : "claude",
                          })
                        }
                        className="w-full flex items-center gap-2 px-3 py-1.5 mx-1 text-left rounded-md text-zinc-600 hover:text-zinc-400 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                        <span className="text-[11px] font-mono">new</span>
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
      <main className="flex-1 overflow-hidden">
        {selectedFile ? (
          <FileEditor
            key={selectedFile.path}
            file={selectedFile}
            onClose={() => setSelectedFile(null)}
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

function FileIcon({ type, tool }: { type: string; tool: "claude" | "codex" }) {
  if (type === "agent" || type === "project_agent") {
    return <span className="text-[11px]">⬡</span>;
  }
  if (type === "settings" || type === "project_settings") {
    return <span className="text-[11px]">⚙</span>;
  }
  if (type === "keybindings") {
    return <span className="text-[11px]">⌨</span>;
  }
  if (type === "mcp") {
    return <span className="text-[11px]">⬡</span>;
  }
  if (type === "rules") {
    return <span className="text-[11px]">⚑</span>;
  }
  return <span className="text-[11px] text-zinc-600">◻</span>;
}

function EmptyEditor() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
        <svg className="w-6 h-6 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
      <p className="text-zinc-500 text-sm">Select a file to edit</p>
      <p className="text-zinc-700 text-xs mt-1 font-mono">CLAUDE.md · AGENTS.md · settings.json · agents · commands</p>
    </div>
  );
}
