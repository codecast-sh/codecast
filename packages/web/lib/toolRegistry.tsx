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
  type LucideIcon
} from "lucide-react";
import { EditToolView } from "@/components/tools/EditToolView";
import { BashToolView } from "@/components/tools/BashToolView";
import { ReadToolView } from "@/components/tools/ReadToolView";
import { TodoToolView } from "@/components/tools/TodoToolView";
import { TaskToolView } from "@/components/tools/TaskToolView";
import { DefaultToolView } from "@/components/tools/DefaultToolView";

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
  }
};

export function getToolConfig(toolName: string): ToolConfig {
  return toolRegistry[toolName] || {
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
