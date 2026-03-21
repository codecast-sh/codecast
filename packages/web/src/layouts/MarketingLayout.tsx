import { Outlet } from "react-router";
import { ForceLightMode } from "@/components/force-light-mode";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export function MarketingLayout() {
  return (
    <>
      <ForceLightMode />
      <div className="light min-h-screen w-full fixed inset-0 overflow-auto" style={{ backgroundColor: '#fdf6e3' }}>
        <ErrorBoundary name="MarketingPage">
          <Outlet />
        </ErrorBoundary>
      </div>
    </>
  );
}
