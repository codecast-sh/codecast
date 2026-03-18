import { use } from "react";
import { ReviewView } from "../../../components/ReviewView";

export default function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return <ReviewView prId={id} />;
}
