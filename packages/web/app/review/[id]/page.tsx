import { useParams } from "next/navigation";
import { ReviewView } from "../../../components/ReviewView";

export default function ReviewPage() {
  const params = useParams();
  const id = params.id as string;

  return <ReviewView prId={id} />;
}
