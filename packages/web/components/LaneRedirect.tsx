// The retired simple lane's routes (/simple and every page under it): each
// address replaces itself with its main-app equivalent (lib/laneRedirect.ts).
import { Navigate, useLocation } from "react-router";
import { laneRedirectTarget } from "../lib/laneRedirect";

export default function LaneRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={laneRedirectTarget(pathname, search, hash) ?? "/inbox"} replace />;
}
