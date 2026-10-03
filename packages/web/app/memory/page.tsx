import { AuthGuard } from "../../components/AuthGuard";
import { MemoryContent } from "../../components/memory/MemoryPage";

export default function MemoryPage() {
  return (
    <AuthGuard>
      <div className="h-full min-h-0">
        <MemoryContent />
      </div>
    </AuthGuard>
  );
}
