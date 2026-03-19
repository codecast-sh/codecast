import { forwardRef, useImperativeHandle, useState, useCallback, useRef } from "react";
import {
  User,
  FileText,
  CheckSquare,
  MessageSquare,
  Map,
  Hash,
} from "lucide-react";

export type MentionItem = {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  image?: string;
  shortId?: string;
};

const TYPE_CONFIG: Record<string, { icon: typeof User; color: string; label: string }> = {
  person: { icon: User, color: "text-sol-green", label: "People" },
  task: { icon: CheckSquare, color: "text-sol-yellow", label: "Tasks" },
  doc: { icon: FileText, color: "text-sol-cyan", label: "Docs" },
  session: { icon: MessageSquare, color: "text-sol-blue", label: "Sessions" },
  plan: { icon: Map, color: "text-sol-violet", label: "Plans" },
};

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
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
        className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 min-w-[280px] max-h-[320px] overflow-y-auto"
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
                return (
                  <button
                    key={item.id}
                    onClick={() => selectItem(globalIdx)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${
                      isSelected
                        ? "bg-sol-bg-highlight text-sol-text"
                        : "text-sol-text-muted hover:bg-sol-bg-alt"
                    }`}
                  >
                    {item.image ? (
                      <img
                        src={item.image}
                        alt=""
                        className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <Hash className={`w-3.5 h-3.5 flex-shrink-0 ${config.color} opacity-60`} />
                    )}
                    <span className="text-sm truncate flex-1">{item.label}</span>
                    {item.sublabel && (
                      <span className="text-[11px] text-sol-text-dim font-mono flex-shrink-0">
                        {item.sublabel}
                      </span>
                    )}
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
