export const dynamic = "force-dynamic";

import { ConfigEditor } from "../../components/ConfigEditor";
import { AuthGuard } from "../../components/AuthGuard";

export default function ConfigPage() {
  return (
    <AuthGuard>
      <ConfigEditor />
    </AuthGuard>
  );
}
