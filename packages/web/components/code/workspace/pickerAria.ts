// The listbox pattern every editor picker shares (quick open, the tab
// switcher, the session picker): focus stays on one control (a filter field,
// or the list itself), the arrows move a highlight, and aria-activedescendant
// names the highlighted row, so a screen reader hears each step.

import { useId } from "react";

export function usePickerAria(selected: string | number | null) {
  const id = useId();
  const listId = `${id}list`;
  // Keys may hold characters an id should not (a NUL-prefixed sentinel).
  const optionId = (key: string | number) => `${id}o${String(key).replace(/[^\w-]/g, "_")}`;
  const active = selected == null ? undefined : optionId(selected);
  return {
    /** For the filter field that keeps focus while the arrows move. */
    field: { role: "combobox" as const, "aria-controls": listId, "aria-expanded": true, "aria-autocomplete": "list" as const, "aria-activedescendant": active },
    /** For the list; with no field, the list holds focus itself. */
    list: (focusable = false) => ({ id: listId, role: "listbox" as const, ...(focusable ? { tabIndex: -1, "aria-activedescendant": active } : {}) }),
    option: (key: string | number, isSelected: boolean) => ({ id: optionId(key), role: "option" as const, "aria-selected": isSelected }),
  };
}
