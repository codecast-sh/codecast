// The documentation page's table of contents: the sidebar, the phone bar and
// the scroll spy all read it.
export const TOC: { id: string; label: string; group?: string; children: { id: string; label: string }[] }[] = [
  { id: "getting-started", label: "Getting Started", group: "Using codecast", children: [
    { id: "open-app", label: "Open codecast" },
    { id: "installation", label: "Connect your computer" },
    { id: "chrome-extension", label: "Chrome & Mac apps" },
  ]},
  { id: "desktop-app", label: "The App", children: [
    { id: "inbox", label: "Inbox" },
    { id: "conversations", label: "Conversations" },
    { id: "command-palette", label: "Command Palette" },
    { id: "changes", label: "Changes" },
    { id: "dashboard-plans", label: "Tasks & Plans" },
    { id: "documents", label: "Documents" },
    { id: "chat", label: "Chat & Calls" },
    { id: "inbox-shortcuts", label: "Keyboard Shortcuts" },
    { id: "desktop-download", label: "Download" },
  ]},
  { id: "mobile-app", label: "Mobile App", children: [
    { id: "mobile-features", label: "Features" },
    { id: "mobile-download", label: "Download" },
  ]},
  { id: "teams", label: "Teams", children: [
    { id: "team-setup", label: "Setup" },
    { id: "team-sharing", label: "Sharing & Privacy" },
  ]},
  { id: "integrations", label: "Integrations", children: [
    { id: "supported-tools", label: "Supported Tools" },
    { id: "github-integration", label: "GitHub" },
  ]},
  { id: "guides", label: "Guides", children: [] },
  { id: "agent-memory", label: "Agent Memory", group: "Agents & the CLI", children: [
    { id: "memory-setup", label: "Setup" },
    { id: "memory-commands", label: "Commands" },
    { id: "memory-how-it-works", label: "How It Works" },
  ]},
  { id: "search-browse", label: "Search & Browse", children: [
    { id: "search", label: "Search" },
    { id: "feed-list", label: "Feed & List" },
    { id: "read", label: "Read Messages" },
  ]},
  { id: "session-analysis", label: "Session Analysis", children: [
    { id: "diff-summary", label: "Diff & Summary" },
    { id: "context-handoff", label: "Context & Handoff" },
    { id: "blame-similar", label: "Blame & Similar" },
  ]},
  { id: "editor-integration", label: "Editor Integration", children: [
    { id: "blame-sessions", label: "Session Blame" },
    { id: "vim-fugitive", label: "Vim / Neovim" },
    { id: "vscode-cursor", label: "VS Code / Cursor" },
  ]},
  { id: "plans", label: "Plans", children: [
    { id: "plans-overview", label: "Overview" },
    { id: "plans-commands", label: "Commands" },
    { id: "plans-workflow", label: "Workflow" },
    { id: "orchestration", label: "Orchestration" },
  ]},
  { id: "tasks", label: "Tasks", children: [
    { id: "tasks-overview", label: "Overview" },
    { id: "tasks-commands", label: "Commands" },
    { id: "task-mining", label: "Auto-Mining & Triage" },
  ]},
  { id: "workflows", label: "Workflows", children: [
    { id: "workflow-nodes", label: "Node Types" },
    { id: "workflow-execution", label: "Execution" },
  ]},
  { id: "triggers", label: "Triggers", children: [
    { id: "trigger-overview", label: "Overview" },
    { id: "trigger-commands", label: "Commands" },
    { id: "trigger-events", label: "Event Triggers" },
  ]},
  { id: "knowledge", label: "Knowledge", children: [
    { id: "decisions", label: "Decisions" },
    { id: "bookmarks", label: "Bookmarks" },
  ]},
  { id: "daemon", label: "Background Sync", children: [
    { id: "authentication", label: "Authentication" },
    { id: "daemon-commands", label: "The Daemon" },
  ]},
  { id: "reference", label: "CLI Reference", children: [] },
];
