/** Next index for arrow keys inside a roving tabindex radio group.
 *  `columns` is the grid width; pass 1 for a vertical list. Left and Right
 *  wrap; Up and Down stop at the edges. Returns null for other keys. */
export function moveRadioIndex(key: string, index: number, length: number, columns: number): number | null {
  switch (key) {
    case "ArrowRight": return (index + 1) % length;
    case "ArrowLeft": return (index - 1 + length) % length;
    case "ArrowDown": return Math.min(index + columns, length - 1);
    case "ArrowUp": return Math.max(index - columns, 0);
    case "Home": return 0;
    case "End": return length - 1;
    default: return null;
  }
}
