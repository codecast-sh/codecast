"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AuthGuard } from "../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationDiffLayout } from "../../../../components/ConversationDiffLayout";
import { ConversationData } from "../../../../components/ConversationView";
import { useConversationMessages } from "../../../../hooks/useConversationMessages";
import { useDiffViewerStore } from "../../../../store/diffViewerStore";

export default function ConversationDiffPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const changeParam = searchParams.get("change");

  const { conversation } = useConversationMessages(id);
  const { selectChange } = useDiffViewerStore();

  useEffect(() => {
    if (changeParam) {
      const changeIndex = parseInt(changeParam, 10) - 1;
      if (!isNaN(changeIndex) && changeIndex >= 0) {
        selectChange(changeIndex);
      }
    }
  }, [changeParam, selectChange]);

  if (!conversation) {
    return (
      <AuthGuard>
        <DashboardLayout hideSidebar>
          <div className="h-[calc(100vh-56px)] w-full flex items-center justify-center">
            <div className="text-muted-foreground">Loading conversation...</div>
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <DashboardLayout hideSidebar>
        <ConversationDiffLayout conversation={conversation as ConversationData} embedded />
      </DashboardLayout>
    </AuthGuard>
  );
}
