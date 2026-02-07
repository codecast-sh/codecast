import {
  FileEdit,
  Terminal,
  FileText,
  CheckSquare,
  Rocket,
  Search,
  FileSearch,
  Globe,
  Code,
  Monitor,
  Navigation,
  MousePointer,
  Eye,
  FormInput,
  Camera,
  Layers,
  Settings,
  ListPlus,
  ListChecks,
  ClipboardList,
  Users,
  UserMinus,
  MessageSquare,
  type LucideIcon
} from "lucide-react";
import { EditToolView } from "@/components/tools/EditToolView";
import { BashToolView } from "@/components/tools/BashToolView";
import { ReadToolView } from "@/components/tools/ReadToolView";
import { TodoToolView } from "@/components/tools/TodoToolView";
import { TaskToolView } from "@/components/tools/TaskToolView";
import { AskUserQuestionToolView } from "@/components/tools/AskUserQuestionToolView";
import { DefaultToolView } from "@/components/tools/DefaultToolView";
import { TaskListToolView } from "@/components/tools/TaskListToolView";
import { SendMessageToolView } from "@/components/tools/SendMessageToolView";

function truncate(str: string | undefined, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "..." : str;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (path === "/" || path === "") return host;
    const shortPath = path.length > 25 ? path.slice(0, 22) + "..." : path;
    return host + shortPath;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + "..." : url;
  }
}

export interface ToolConfig {
  title: string;
  icon: LucideIcon;
  color: string;
  component: React.ComponentType<ToolViewProps>;
  extractSummary?: (input: any, output: any) => string;
}

export interface ToolViewProps {
  name: string;
  input?: any;
  output?: any;
  timestamp: number;
}

export const toolRegistry: Record<string, ToolConfig> = {
  Edit: {
    title: "Edit File",
    icon: FileEdit,
    color: "amber",
    component: EditToolView,
    extractSummary: (input, output) => {
      if (input?.file_path) {
        const fileName = input.file_path.split('/').pop();
        return `Edited ${fileName}`;
      }
      return "File edited";
    }
  },

  Write: {
    title: "Write File",
    icon: FileEdit,
    color: "emerald",
    component: EditToolView,
    extractSummary: (input, output) => {
      if (input?.file_path) {
        const fileName = input.file_path.split('/').pop();
        return `Wrote ${fileName}`;
      }
      return "File written";
    }
  },

  Bash: {
    title: "Terminal",
    icon: Terminal,
    color: "emerald",
    component: BashToolView,
    extractSummary: (input, output) => {
      if (input?.command) {
        const cmd = input.command.split(' ')[0];
        return `Ran: ${cmd}`;
      }
      return "Command executed";
    }
  },

  Read: {
    title: "Read File",
    icon: FileText,
    color: "blue",
    component: ReadToolView,
    extractSummary: (input, output) => {
      if (input?.file_path) {
        const fileName = input.file_path.split('/').pop();
        return `Read ${fileName}`;
      }
      return "File read";
    }
  },

  Glob: {
    title: "Search Files",
    icon: FileSearch,
    color: "violet",
    component: DefaultToolView,
    extractSummary: (input, output) => {
      if (input?.pattern) {
        return `Search: ${input.pattern}`;
      }
      return "File search";
    }
  },

  Grep: {
    title: "Search Content",
    icon: Search,
    color: "pink",
    component: DefaultToolView,
    extractSummary: (input, output) => {
      if (input?.pattern) {
        return `Grep: ${input.pattern}`;
      }
      return "Content search";
    }
  },

  Task: {
    title: "Subagent Task",
    icon: Rocket,
    color: "cyan",
    component: TaskToolView,
    extractSummary: (input, output) => {
      if (input?.description) {
        return input.description;
      }
      if (input?.subagent_type) {
        return `${input.subagent_type} agent`;
      }
      return "Agent task";
    }
  },

  TodoWrite: {
    title: "Todo List",
    icon: CheckSquare,
    color: "violet",
    component: TodoToolView,
    extractSummary: (input, output) => {
      if (input?.todos && Array.isArray(input.todos)) {
        return `${input.todos.length} todos`;
      }
      return "Updated todos";
    }
  },

  AskUserQuestion: {
    title: "Question",
    icon: FormInput,
    color: "violet",
    component: AskUserQuestionToolView,
    extractSummary: (input) => {
      const questions = input?.questions;
      if (Array.isArray(questions) && questions.length > 0) {
        const header = questions[0].header;
        if (header) return header;
        const q = questions[0].question;
        return q?.length > 40 ? q.slice(0, 37) + "..." : q || "Question";
      }
      return "Question";
    }
  },

  TaskCreate: {
    title: "Create Task",
    icon: ListPlus,
    color: "emerald",
    component: DefaultToolView,
    extractSummary: (input) => {
      if (input?.subject) return truncate(input.subject, 50);
      return "New task";
    }
  },

  TaskUpdate: {
    title: "Update Task",
    icon: ListChecks,
    color: "emerald",
    component: DefaultToolView,
    extractSummary: (input) => {
      const id = input?.taskId || "";
      const status = input?.status;
      if (id && status) return `#${id} -> ${status}`;
      if (id) return `#${id}`;
      return "Update task";
    }
  },

  TaskList: {
    title: "Task List",
    icon: ClipboardList,
    color: "emerald",
    component: TaskListToolView,
    extractSummary: (_input, output) => {
      if (typeof output === "string") {
        const lines = output.split("\n").filter(l => l.match(/#\d+\s+\[/));
        if (lines.length > 0) return `${lines.length} tasks`;
      }
      return "Tasks";
    }
  },

  TaskGet: {
    title: "Get Task",
    icon: ClipboardList,
    color: "emerald",
    component: DefaultToolView,
    extractSummary: (input) => input?.taskId ? `#${input.taskId}` : "Get task"
  },

  TeamCreate: {
    title: "Create Team",
    icon: Users,
    color: "cyan",
    component: DefaultToolView,
    extractSummary: (input) => input?.team_name || "New team"
  },

  TeamDelete: {
    title: "Delete Team",
    icon: UserMinus,
    color: "cyan",
    component: DefaultToolView,
    extractSummary: () => "Cleanup"
  },

  SendMessage: {
    title: "Message",
    icon: MessageSquare,
    color: "amber",
    component: SendMessageToolView,
    extractSummary: (input) => {
      if (input?.summary) return truncate(input.summary, 40);
      if (input?.recipient) return `to ${input.recipient}`;
      if (input?.type === "broadcast") return "broadcast";
      return "Message";
    }
  },

  WebSearch: {
    title: "Web Search",
    icon: Globe,
    color: "blue",
    component: DefaultToolView,
    extractSummary: (input, output) => {
      if (input?.query) {
        return `Search: ${input.query}`;
      }
      return "Web search";
    }
  },

  WebFetch: {
    title: "Web Fetch",
    icon: Globe,
    color: "cyan",
    component: DefaultToolView,
    extractSummary: (input, output) => {
      if (input?.url) {
        try {
          const url = new URL(input.url);
          return url.hostname;
        } catch {
          return "Fetched URL";
        }
      }
      return "Web fetch";
    }
  },

  "mcp__claude-in-chrome__computer": {
    title: "Browser",
    icon: MousePointer,
    color: "orange",
    component: DefaultToolView,
    extractSummary: (input) => {
      const action = input?.action;
      if (action === "screenshot") return "Screenshot";
      if (action === "left_click") {
        const coord = input?.coordinate;
        return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
      }
      if (action === "type") return `Type "${truncate(input?.text, 20)}"`;
      if (action === "key") return `Key: ${input?.text}`;
      if (action === "scroll") return `Scroll ${input?.scroll_direction}`;
      if (action === "wait") return `Wait ${input?.duration}s`;
      if (action === "zoom") return "Zoom";
      if (action === "hover") return "Hover";
      return action || "Browser action";
    }
  },

  "mcp__claude-in-chrome__navigate": {
    title: "Navigate",
    icon: Navigation,
    color: "blue",
    component: DefaultToolView,
    extractSummary: (input) => {
      if (input?.url) {
        if (input.url === "back") return "Back";
        if (input.url === "forward") return "Forward";
        return shortenUrl(input.url);
      }
      return "Navigate";
    }
  },

  "mcp__claude-in-chrome__read_page": {
    title: "Read Page",
    icon: Eye,
    color: "blue",
    component: DefaultToolView,
    extractSummary: (input) => {
      if (input?.ref_id) return `Element ${input.ref_id}`;
      if (input?.filter === "interactive") return "Interactive elements";
      return "Page content";
    }
  },

  "mcp__claude-in-chrome__find": {
    title: "Find",
    icon: Search,
    color: "violet",
    component: DefaultToolView,
    extractSummary: (input) => input?.query ? `"${truncate(input.query, 30)}"` : "Find element"
  },

  "mcp__claude-in-chrome__form_input": {
    title: "Form Input",
    icon: FormInput,
    color: "amber",
    component: DefaultToolView,
    extractSummary: (input) => {
      const ref = input?.ref;
      const val = input?.value;
      if (ref && val !== undefined) return `${ref} = "${truncate(String(val), 20)}"`;
      return "Set form value";
    }
  },

  "mcp__claude-in-chrome__javascript_tool": {
    title: "JavaScript",
    icon: Code,
    color: "amber",
    component: DefaultToolView,
    extractSummary: (input) => {
      if (input?.text) return truncate(input.text, 40);
      return "Execute JS";
    }
  },

  "mcp__claude-in-chrome__tabs_context_mcp": {
    title: "Tab Context",
    icon: Layers,
    color: "gray",
    component: DefaultToolView,
    extractSummary: () => "Get tabs"
  },

  "mcp__claude-in-chrome__tabs_create_mcp": {
    title: "New Tab",
    icon: Layers,
    color: "gray",
    component: DefaultToolView,
    extractSummary: () => "Create tab"
  },

  "mcp__claude-in-chrome__update_plan": {
    title: "Update Plan",
    icon: CheckSquare,
    color: "cyan",
    component: DefaultToolView,
    extractSummary: (input) => {
      const domains = input?.domains;
      if (Array.isArray(domains) && domains.length) {
        return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
      }
      return "Plan update";
    }
  },

  "mcp__claude-in-chrome__gif_creator": {
    title: "GIF",
    icon: Camera,
    color: "pink",
    component: DefaultToolView,
    extractSummary: (input) => input?.action || "Record"
  },

  "mcp__claude-in-chrome__read_console_messages": {
    title: "Console",
    icon: Terminal,
    color: "emerald",
    component: DefaultToolView,
    extractSummary: (input) => input?.pattern ? `Filter: ${input.pattern}` : "Read console"
  },

  "mcp__claude-in-chrome__read_network_requests": {
    title: "Network",
    icon: Globe,
    color: "emerald",
    component: DefaultToolView,
    extractSummary: (input) => input?.urlPattern ? `Filter: ${input.urlPattern}` : "Read network"
  },

  "mcp__claude-in-chrome__get_page_text": {
    title: "Page Text",
    icon: FileText,
    color: "blue",
    component: DefaultToolView,
    extractSummary: () => "Extract text"
  },

  "mcp__claude-in-chrome__upload_image": {
    title: "Upload",
    icon: Camera,
    color: "violet",
    component: DefaultToolView,
    extractSummary: (input) => input?.filename || "Upload image"
  },

  "mcp__claude-in-chrome__resize_window": {
    title: "Resize",
    icon: Monitor,
    color: "gray",
    component: DefaultToolView,
    extractSummary: (input) => input?.width && input?.height ? `${input.width}x${input.height}` : "Resize window"
  },

  "mcp__claude-in-chrome__shortcuts_list": {
    title: "Shortcuts",
    icon: Settings,
    color: "gray",
    component: DefaultToolView,
    extractSummary: () => "List shortcuts"
  },

  "mcp__claude-in-chrome__shortcuts_execute": {
    title: "Shortcut",
    icon: Rocket,
    color: "cyan",
    component: DefaultToolView,
    extractSummary: (input) => input?.command ? `/${input.command}` : "Run shortcut"
  }
};

export function getToolConfig(toolName: string): ToolConfig {
  if (toolRegistry[toolName]) {
    return toolRegistry[toolName];
  }

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const serverName = parts[1] || "mcp";
    const methodName = parts[2] || "";
    const displayServer = serverName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const displayMethod = methodName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    return {
      title: displayMethod || displayServer,
      icon: Globe,
      color: "cyan",
      component: DefaultToolView,
      extractSummary: (input) => {
        if (input?.url) return shortenUrl(input.url);
        if (input?.query) return truncate(input.query, 30);
        if (input?.action) return input.action;
        return displayServer;
      }
    };
  }

  return {
    title: toolName,
    icon: Code,
    color: "gray",
    component: DefaultToolView
  };
}

const colorMap: Record<string, string> = {
  amber: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  emerald: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
  blue: "text-blue-500 bg-blue-500/10 border-blue-500/20",
  violet: "text-violet-500 bg-violet-500/10 border-violet-500/20",
  pink: "text-pink-500 bg-pink-500/10 border-pink-500/20",
  cyan: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
  gray: "text-gray-500 bg-gray-500/10 border-gray-500/20"
};

export function getToolColor(color: string): string {
  return colorMap[color] || colorMap.gray;
}
