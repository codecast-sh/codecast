import assert from "node:assert/strict";
import { mock } from "bun:test";
import { getFunctionName } from "convex/server";

process.exitCode = 1;
const starts = [];
const joins = [];
const routes = [];
const alerts = [];
let occupied = false;
mock.module("react-native", () => ({
  TouchableOpacity: "button", StyleSheet: { create: (styles) => styles },
  Alert: { alert: (...args) => alerts.push(args) },
}));
mock.module("expo-router", () => ({ useRouter: () => ({ push: (route) => routes.push(route) }) }));
mock.module("expo-haptics", () => ({ ImpactFeedbackStyle: { Medium: "medium" }, impactAsync: async () => {} }));
mock.module("@expo/vector-icons", () => ({ Ionicons: "icon" }));
mock.module("convex/react", () => ({ useQuery: (query) => getFunctionName(query) === "calls:getCallConfig" ? { enabled: true, teams: ["team"] } : { "channel:design": occupied ? [{}] : [] } }));
mock.module("@/components/Themed", () => ({ Text: "span" }));
mock.module("@/constants/Theme", () => ({ Theme: {}, useTheme: () => ({}), themedStyles: (fn) => fn({}) }));
mock.module("@/lib/calls/callManager", () => ({ startHuddle: async (opts) => { starts.push(opts); }, joinCall: async (room) => { joins.push(room); } }));
const { HuddleButton } = await import("../../../components/calls/SessionHuddleButton");
const button = (count) => HuddleButton({ roomKey: "channel:design", teamId: "team", channelMemberCount: count, anchorTitle: "#design" });
button(7).props.onPress();
assert.equal(starts.length, 1);
assert.equal(starts[0].ringChannel, true);
assert.deepEqual(routes, ["/call"]);
button(8).props.onPress();
assert.equal(starts.length, 1);
assert.equal(routes.length, 1);
assert.match(alerts[0][1], /8 members.*7 other members/);
assert.equal(alerts[0][2][0].style, "cancel");
assert.equal(alerts[0][2][0].onPress, undefined);
alerts[0][2][1].onPress();
assert.equal(starts.length, 2);
assert.equal(routes.length, 2);
assert.equal(button().props.disabled, true);
occupied = true;
button(8).props.onPress();
assert.deepEqual(joins, ["channel:design"]);
assert.equal(starts.length, 2);
assert.equal(alerts.length, 1);
process.exitCode = 0;
