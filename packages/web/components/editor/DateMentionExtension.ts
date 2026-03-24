import Mention from "@tiptap/extension-mention";
import { ReactRenderer, ReactNodeViewRenderer } from "@tiptap/react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionItem } from "./MentionList";
import { MentionNodeView } from "./MentionNodeView";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function nextDayOfWeek(from: Date, dow: number): Date {
  const d = new Date(from);
  const diff = (dow - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function endOfWeek(d: Date): Date {
  return nextDayOfWeek(d, 5);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAYS_OF_WEEK = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function formatShort(d: Date): string {
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function tryParseDate(q: string): Date | null {
  const now = new Date();

  const isoMatch = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const d = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    if (!isNaN(d.getTime())) return d;
  }

  const slashMatch = q.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (slashMatch) {
    const m = +slashMatch[1] - 1;
    const day = +slashMatch[2];
    const year = slashMatch[3] ? (+slashMatch[3] < 100 ? 2000 + +slashMatch[3] : +slashMatch[3]) : now.getFullYear();
    const d = new Date(year, m, day);
    if (!isNaN(d.getTime())) return d;
  }

  const monthDayMatch = q.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/i);
  if (monthDayMatch) {
    const mi = SHORT_MONTHS.findIndex(
      (m) => m.toLowerCase() === monthDayMatch[1].slice(0, 3).toLowerCase()
    );
    if (mi >= 0) {
      const year = monthDayMatch[3] ? +monthDayMatch[3] : now.getFullYear();
      const d = new Date(year, mi, +monthDayMatch[2]);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

function getDateSuggestions(query: string): MentionItem[] {
  const today = startOfDay(new Date());
  const q = query.toLowerCase().trim();

  const statics: Array<{ label: string; date: Date }> = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "Yesterday", date: addDays(today, -1) },
    { label: "Next Monday", date: nextDayOfWeek(today, 1) },
    { label: "Next Tuesday", date: nextDayOfWeek(today, 2) },
    { label: "Next Wednesday", date: nextDayOfWeek(today, 3) },
    { label: "Next Thursday", date: nextDayOfWeek(today, 4) },
    { label: "Next Friday", date: nextDayOfWeek(today, 5) },
    { label: "End of week", date: endOfWeek(today) },
    { label: "End of month", date: endOfMonth(today) },
    { label: "In 1 week", date: addDays(today, 7) },
    { label: "In 2 weeks", date: addDays(today, 14) },
    { label: "In 1 month", date: addMonths(today, 1) },
  ];

  let filtered = statics;
  if (q) {
    filtered = statics.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        formatShort(s.date).toLowerCase().includes(q) ||
        toISO(s.date).includes(q) ||
        DAYS_OF_WEEK[s.date.getDay()].toLowerCase().includes(q)
    );
  }

  const items: MentionItem[] = filtered.map((s) => ({
    id: toISO(s.date),
    type: "date",
    label: s.label,
    sublabel: formatShort(s.date),
  }));

  if (q) {
    const parsed = tryParseDate(q);
    if (parsed && !items.some((i) => i.id === toISO(parsed))) {
      items.unshift({
        id: toISO(parsed),
        type: "date",
        label: formatShort(parsed),
        sublabel: DAYS_OF_WEEK[parsed.getDay()],
      });
    }
  }

  return items;
}

function createDateSuggestion() {
  return {
    char: "#",
    items: ({ query }: { query: string }) => getDateSuggestions(query),
    render: () => {
      let component: ReactRenderer<any> | null = null;
      let popup: TippyInstance[] | null = null;
      return {
        onStart: (props: any) => {
          component = new ReactRenderer(MentionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;
          popup = tippy("body", {
            getReferenceClientRect: props.clientRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
            zIndex: 10002,
          });
        },
        onUpdate(props: any) {
          component?.updateProps(props);
          if (popup?.[0] && props.clientRect) {
            popup[0].setProps({ getReferenceClientRect: props.clientRect });
          }
        },
        onKeyDown(props: any) {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },
        onExit() {
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}

export const DateMentionExtension = Mention.extend({
  name: "dateMention",
  addAttributes() {
    return {
      ...this.parent?.(),
      type: { default: "date" },
      dateValue: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span.editor-date-pill",
        getAttrs: (el: HTMLElement) => ({
          id: el.getAttribute("data-date") || "",
          label: el.getAttribute("data-label") || el.textContent?.replace(/^#/, "") || "",
          type: "date",
          dateValue: el.getAttribute("data-date") || "",
        }),
      },
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView);
  },
}).configure({
  HTMLAttributes: { class: "editor-date-pill" },
  suggestion: {
    ...createDateSuggestion(),
    command: ({ editor: e, range, props: item }: any) => {
      e.chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "dateMention",
            attrs: {
              id: item.id,
              label: item.label,
              type: "date",
              dateValue: item.id,
            },
          },
          { type: "text", text: " " },
        ])
        .run();
    },
  },
  renderHTML({ node }: any) {
    const attrs = node.attrs;
    return [
      "span",
      {
        class: "editor-date-pill",
        "data-date": attrs.dateValue || attrs.id,
        "data-label": attrs.label,
      },
      `#${attrs.label}`,
    ];
  },
});

export { getDateSuggestions, formatShort, toISO };
