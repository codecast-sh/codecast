// Create a team: the same setup flow a new person walks on /welcome
// (components/onboarding/SetupFlow), opened from Settings.
import { SetupFlow } from "../../../../components/onboarding/SetupFlow";

export default function CreateTeamPage() {
  return <SetupFlow mode="create" />;
}
