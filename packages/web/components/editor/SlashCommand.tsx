import { forwardRef, useImperativeHandle, useState, useCallback } from "react";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Quote,
  Minus,
  Image,
  type LucideIcon,
} from "lucide-react";

export type SlashCommandItem = {
  title: string;
  description: string;
  icon: LucideIcon;
  command: (editor: any) => void;
};

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    title: "Heading 1",
    description: "Large section heading",
    icon: Heading1,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    icon: Heading2,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    icon: Heading3,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    title: "Bullet List",
    description: "Unordered list",
    icon: List,
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    title: "Numbered List",
    description: "Ordered list",
    icon: ListOrdered,
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    title: "Task List",
    description: "Checklist with checkboxes",
    icon: CheckSquare,
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    title: "Code Block",
    description: "Fenced code block",
    icon: Code,
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    title: "Blockquote",
    description: "Quoted text block",
    icon: Quote,
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    title: "Divider",
    description: "Horizontal rule",
    icon: Minus,
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    title: "Image",
    description: "Insert image from URL",
    icon: Image,
    command: (editor) => {
      const url = window.prompt("Image URL:");
      if (url) editor.chain().focus().setImage({ src: url }).run();
    },
  },
];

interface SlashCommandListProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
  editor: any;
}

export const SlashCommandList = forwardRef<any, SlashCommandListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

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
        <div className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl p-3 min-w-[200px]">
          <p className="text-xs text-sol-text-dim text-center">No matching commands</p>
        </div>
      );
    }

    return (
      <div className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 min-w-[240px] max-h-[320px] overflow-y-auto">
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={item.title}
              onClick={() => selectItem(i)}
              onMouseEnter={() => setSelectedIndex(i)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                i === selectedIndex
                  ? "bg-sol-bg-highlight text-sol-text"
                  : "text-sol-text-muted hover:bg-sol-bg-alt"
              }`}
            >
              <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                i === selectedIndex ? "bg-sol-cyan/15 text-sol-cyan" : "bg-sol-bg-alt text-sol-text-dim"
              }`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-[11px] text-sol-text-dim">{item.description}</p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }
);

SlashCommandList.displayName = "SlashCommandList";
