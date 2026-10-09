/**
 * The task page's properties card: the rhythm every row in it shares, one
 * label track then the value. The relation rows (components/tasks/TaskRelations)
 * and the static rows in app/tasks/[id]/page.tsx (Issue, Created, Closed,
 * Started, Confidence, Labels) all read this one constant, because Blocked by's
 * pills have to line up with Created's date — moving one row's track alone
 * leaves the card ragged. It lives here rather than beside the component so
 * that file stays a Fast Refresh boundary (lib/__tests__/fastRefreshBoundaries).
 *
 * The track fits the longest label any row prints. "Blocked by (cleared)"
 * (`blockedByLabel`, TG12) is 20 characters, and the labels are 12px in the
 * app's mono UI face (--font-ui), so 20 × 0.6em = 144px: at 7rem = 112px that
 * heading wrapped to a second line inside a 20px box and painted over the row
 * below it. 9.5rem leaves slack, and covers the SF Pro theme's widths too.
 */
export const PROP_GRID = "grid grid-cols-[9.5rem_1fr]";
