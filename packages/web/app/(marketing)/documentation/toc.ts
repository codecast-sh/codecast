// The documentation page's table of contents: the sidebar, the phone bar and
// the scroll spy all read it. Every id here is a heading id in page.tsx.
export const TOC: { id: string; label: string; group?: string; children: { id: string; label: string }[] }[] = [
  { id: "getting-started", label: "Getting started", group: "Using codecast", children: [
    { id: "open-app", label: "Open codecast" },
    { id: "installation", label: "Connect your computer" },
    { id: "chrome-extension", label: "Chrome & Mac apps" },
  ]},
  { id: "inbox", label: "Inbox", children: [
    { id: "inbox-groups", label: "How cards are grouped" },
    { id: "decisions", label: "Decisions" },
    { id: "inbox-shortcuts", label: "Keyboard shortcuts" },
  ]},
  { id: "conversations", label: "Conversations", children: [
    { id: "steer", label: "Steer a running agent" },
    { id: "permissions", label: "Permissions" },
    { id: "diff-panel", label: "Diff & branch map" },
  ]},
  { id: "command-palette", label: "Command palette", children: [] },
  { id: "changes", label: "Changes", children: [] },
  { id: "tasks-plans", label: "Tasks & plans", children: [
    { id: "tasks", label: "Tasks" },
    { id: "plans", label: "Plans" },
  ]},
  { id: "triggers", label: "Triggers & workflows", children: [] },
  { id: "documents", label: "Documents", children: [] },
  { id: "chat", label: "Chat & calls", children: [
    { id: "channels", label: "Channels" },
    { id: "calls", label: "Calls" },
  ]},
  { id: "mobile-app", label: "Mobile app", children: [
    { id: "mobile-inbox", label: "Inbox & sessions" },
    { id: "mobile-download", label: "Download" },
  ]},
  { id: "teams", label: "Teams", children: [
    { id: "team-setup", label: "Create or join a team" },
    { id: "team-sharing", label: "What your team sees" },
  ]},
  { id: "integrations", label: "Integrations", children: [
    { id: "supported-tools", label: "Coding agents" },
    { id: "connected-apps", label: "GitHub, Slack & more" },
  ]},
  { id: "desktop-download", label: "Mac app", children: [] },
  { id: "guides", label: "Guides", children: [] },
  { id: "cli", label: "For agents and scripts", group: "Agents & the CLI", children: [
    { id: "cli-background", label: "The background app" },
    { id: "cli-reference", label: "Command reference" },
    { id: "editor-integration", label: "Editor blame" },
  ]},
];
