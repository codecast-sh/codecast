import { forwardRef, useImperativeHandle, useState, useCallback, useRef } from "react";
import {
  User,
  FileText,
  CheckSquare,
  MessageSquare,
  Target,
  Calendar,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
} from "lucide-react";

export type MentionItem = {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  image?: string;
  shortId?: string;
  status?: string;
  priority?: string;
  docType?: string;
  messageCount?: number;
  projectPath?: string;
  goal?: string;
  model?: string;
  agentType?: string;
  updatedAt?: number;
  idleSummary?: string;
};

const TYPE_CONFIG: Record<string, { icon: typeof User; color: string; label: string }> = {
  person: { icon: User, color: "text-sol-green", label: "People" },
  task: { icon: CheckSquare, color: "text-sol-yellow", label: "Tasks" },
  doc: { icon: FileText, color: "text-sol-cyan", label: "Docs" },
  session: { icon: MessageSquare, color: "text-sol-blue", label: "Sessions" },
  plan: { icon: Target, color: "text-sol-violet", label: "Plans" },
  date: { icon: Calendar, color: "text-sol-orange", label: "Dates" },
};

const STATUS_ICONS: Record<string, typeof Circle> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};

const STATUS_COLORS: Record<string, string> = {
  draft: "text-sol-text-dim",
  open: "text-sol-blue",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-sol-text-dim",
};

const PRIORITY_ICONS: Record<string, typeof Minus> = {
  urgent: AlertTriangle,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "text-sol-red",
  high: "text-sol-orange",
  medium: "text-sol-text-dim",
  low: "text-sol-text-dim",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  plan: "text-sol-blue bg-sol-blue/10",
  design: "text-sol-violet bg-sol-violet/10",
  spec: "text-sol-cyan bg-sol-cyan/10",
  investigation: "text-sol-yellow bg-sol-yellow/10",
  handoff: "text-sol-orange bg-sol-orange/10",
  note: "text-sol-text-muted bg-sol-text-muted/10",
};

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
}

function abbrevModel(model?: string | null): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return null;
}

function ItemIcon({ item, config }: { item: MentionItem; config: typeof TYPE_CONFIG[string] }) {
  if (item.image) {
    return <img src={item.image} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />;
  }

  if (item.type === "task" && item.status) {
    const StatusIcon = STATUS_ICONS[item.status] || Circle;
    const statusColor = STATUS_COLORS[item.status] || "text-sol-text-dim";
    return <StatusIcon className={`w-4 h-4 flex-shrink-0 ${statusColor}`} />;
  }

  const Icon = config.icon;
  return <Icon className={`w-4 h-4 flex-shrink-0 ${config.color} opacity-70`} />;
}

function ItemMeta({ item }: { item: MentionItem }) {
  if (item.type === "task") {
    const showPriority = item.priority && item.priority !== "medium" && item.priority !== "none";
    const PIcon = showPriority ? PRIORITY_ICONS[item.priority!] || Minus : null;
    const pColor = showPriority ? PRIORITY_COLORS[item.priority!] || "" : "";
    return (
      <div className="flex items-center gap-2 mt-0.5 pl-[26px]">
        {item.status && (
          <span className={`text-[10px] ${STATUS_COLORS[item.status] || "text-sol-text-dim"}`}>
            {item.status.replace(/_/g, " ")}
          </span>
        )}
        {PIcon && (
          <PIcon className={`w-3 h-3 ${pColor}`} />
        )}
      </div>
    );
  }

  if (item.type === "doc") {
    const dt = item.docType || item.sublabel || "note";
    const dtColor = DOC_TYPE_COLORS[dt] || DOC_TYPE_COLORS.note;
    return (
      <div className="flex items-center gap-2 mt-0.5 pl-[26px]">
        <span className={`text-[10px] px-1.5 py-0 rounded ${dtColor}`}>{dt}</span>
      </div>
    );
  }

  if (item.type === "session") {
    const project = item.projectPath ? item.projectPath.split("/").pop() : null;
    const model = abbrevModel(item.model);
    const parts = [
      item.messageCount != null ? `${item.messageCount} msgs` : null,
      model,
      project,
    ].filter(Boolean);
    return (
      <div className="flex items-center gap-1.5 mt-0.5 pl-[26px] flex-wrap">
        {item.status === "active" && (
          <span className="w-1.5 h-1.5 rounded-full bg-sol-green flex-shrink-0" />
        )}
        {parts.map((p, i) => (
          <span key={i} className="text-[10px] text-sol-text-dim font-mono">{p}</span>
        ))}
      </div>
    );
  }

  if (item.type === "plan" && item.goal) {
    return (
      <div className="mt-0.5 pl-[26px]">
        <span className="text-[10px] text-sol-text-dim line-clamp-1">{item.goal}</span>
      </div>
    );
  }

  return null;
}

export const MentionList = forwardRef<any, MentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) command(item);
      },
      [items, command]
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) {
      return (
        <div className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl p-3 min-w-[240px]">
          <p className="text-xs text-sol-text-dim text-center">No results</p>
        </div>
      );
    }

    const grouped: Array<{ type: string; items: MentionItem[]; startIdx: number }> = [];
    let idx = 0;
    for (const item of items) {
      let group = grouped.find((g) => g.type === item.type);
      if (!group) {
        group = { type: item.type, items: [], startIdx: idx };
        grouped.push(group);
      }
      group.items.push(item);
      idx++;
    }

    return (
      <div
        ref={containerRef}
        className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 min-w-[320px] max-w-[420px] max-h-[400px] overflow-y-auto"
      >
        {grouped.map((group) => {
          const config = TYPE_CONFIG[group.type] || TYPE_CONFIG.doc;
          const Icon = config.icon;
          return (
            <div key={group.type}>
              <div className="px-3 py-1.5 flex items-center gap-1.5">
                <Icon className={`w-3 h-3 ${config.color}`} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
                  {config.label}
                </span>
              </div>
              {group.items.map((item: MentionItem, i: number) => {
                const globalIdx = group.startIdx + i;
                const isSelected = globalIdx === selectedIndex;
                const hasMeta = (item.type === "task" && item.status) ||
                  (item.type === "doc") ||
                  (item.type === "session" && (item.messageCount != null || item.projectPath)) ||
                  (item.type === "plan" && item.goal);
                return (
                  <button
                    key={item.id}
                    onClick={() => selectItem(globalIdx)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    className={`w-full text-left px-3 ${hasMeta ? "py-2" : "py-1.5"} transition-colors ${
                      isSelected
                        ? "bg-sol-bg-highlight text-sol-text"
                        : "text-sol-text-muted hover:bg-sol-bg-alt"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <ItemIcon item={item} config={config} />
                      <span className="text-sm truncate flex-1">{item.label}</span>
                      {item.shortId && (
                        <span className="text-[10px] text-sol-text-dim font-mono flex-shrink-0">
                          {item.shortId}
                        </span>
                      )}
                      {!item.shortId && item.sublabel && (item.type === "person" || item.type === "date") && (
                        <span className="text-[11px] text-sol-text-dim font-mono flex-shrink-0">
                          {item.sublabel}
                        </span>
                      )}
                    </div>
                    <ItemMeta item={item} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }
);

MentionList.displayName = "MentionList";
