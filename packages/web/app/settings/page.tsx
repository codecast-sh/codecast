import { useRouter } from "next/navigation";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export default function SettingsPage() {
  const router = useRouter();

  useWatchEffect(() => {
    router.replace("/settings/cli");
  }, [router]);

  return null;
}
