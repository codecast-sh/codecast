import { useSlideOutStore } from "../store/slideOutStore";
import { PlanSlideOut } from "./PlanSlideOut";
import { TaskSlideOut } from "./TaskSlideOut";
import { ErrorBoundary } from "./ErrorBoundary";

export function SlideOutProvider() {
  const type = useSlideOutStore((s) => s.type);

  return (
    <ErrorBoundary name="SlideOut" level="panel">
      {type === "plan" && <PlanSlideOut />}
      {type === "task" && <TaskSlideOut />}
    </ErrorBoundary>
  );
}
