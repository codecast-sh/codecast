// The pages that ARE the setup flow: a new person's /start, Create team,
// Join team and an existing team's feature setup (components/onboarding).
// Nothing introduces itself over them: the device-setup dialog, the feature offers and the theme and org intros all
// wait until the person has left the flow, which already asks for what they
// would ask (permissions on the Agents step, every feature on).
const SETUP_FLOW_PATHS = ["/start", "/settings/team/create", "/settings/team/join", "/settings/team/features"];

export function isSetupFlowPath(pathname: string | null | undefined): boolean {
  const p = (pathname ?? "").replace(/\/+$/, "");
  return SETUP_FLOW_PATHS.includes(p);
}
