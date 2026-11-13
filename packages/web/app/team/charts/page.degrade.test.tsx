import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * TEAM CHARTS SURVIVE ONE MEMBER'S PUNCHCARD QUERY FAILING.
 *
 * The page subscribes to one getUserActivityPunchcard per member through
 * useQueries. Convex hands a failed query back as an Error object in that
 * key's slot rather than throwing, and the merge iterated it:
 *   TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))
 * which dropped the whole page into its TeamCharts ErrorBoundary. A failed
 * member must cost only that member's numbers, and the page must say who is
 * missing.
 */

mock.restore();

const convexReact = await import("convex/react");
const { getFunctionName } = await import("convex/server");
afterAll(() => mock.module("convex/react", () => convexReact));

const TEAM_ID = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";
const OK_ID = "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7";
const BAD_ID = "kd78n5cgr6n8cps77ry3d9hn3h8evvwe";
const zeros = () => new Array(24).fill(0);
const hours = zeros();
hours[10] = 2;
const okRows = [
  { date: "2026-11-12", hours, msgs: zeros(), sends: zeros(), words: zeros(), tokens: zeros(), spend: zeros(), sessions: zeros(), day_sessions: 1 },
];

mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (fn: any, args: any) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(fn);
    if (name === "users:getCurrentUser") return { _id: OK_ID, team_id: TEAM_ID };
    if (name === "users:getTeamMembers") return [{ _id: OK_ID, name: "Alexander Green" }, { _id: BAD_ID, name: "Krithik Suvarna" }];
    return undefined;
  },
  useQueries: (queries: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(queries)) {
      if (k === OK_ID) out[k] = okRows;
      else if (k === BAD_ID) out[k] = new Error("[CONVEX Q(users:getUserActivityPunchcard)] Server Error");
      else out[k] = undefined;
    }
    return out;
  },
}));

const realLayout = { ...(await import("../../../components/DashboardLayout")) };
mock.module("../../../components/DashboardLayout", () => ({
  ...realLayout,
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: TeamChartsPage } = await import(`${import.meta.dir}/page.tsx?fresh`);
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");

describe("TeamCharts — a member's failed punchcard query", () => {
  test("renders the page and names the member left out, instead of crashing", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TeamChartsPage />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Failed to load");
    expect(html).toContain("Team activity");
    expect(html).toContain("Not counted: Krithik Suvarna");
    expect(html).toContain("Alexander Green");
  });
});
