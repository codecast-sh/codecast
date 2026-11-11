import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ActivityPage } from "../../components/activity/ActivityPage";

// The message feed is the Messages tab of the Activity page, in every style
// (components/activity): this address opens that tab, whose own toggle says
// whose messages (yours, or the team's with ?filter=team).
export default function FeedPage() {
  return <AuthGuard><DashboardLayout><ActivityPage tab="messages" /></DashboardLayout></AuthGuard>;
}
