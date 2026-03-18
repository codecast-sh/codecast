import { useSlideOutStore } from "../store/slideOutStore";
import { PlanSlideOut } from "./PlanSlideOut";
import { TaskSlideOut } from "./TaskSlideOut";

export function SlideOutProvider() {
  const type = useSlideOutStore((s) => s.type);

  return (
    <>
      {type === "plan" && <PlanSlideOut />}
      {type === "task" && <TaskSlideOut />}
    </>
  );
}
