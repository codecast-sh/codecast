import { useState } from "react";

interface ConversationTabsProps {
  onFilterChange: (filter: "my" | "team") => void;
}

export function ConversationTabs({ onFilterChange }: ConversationTabsProps) {
  const [activeTab, setActiveTab] = useState<"my" | "team">("my");

  const handleTabChange = (tab: "my" | "team") => {
    setActiveTab(tab);
    onFilterChange(tab);
  };

  return (
    <div className="flex gap-6 border-b border-sol-base01 mb-6">
      <button
        onClick={() => handleTabChange("my")}
        className={`pb-3 text-sm font-medium transition-colors ${
          activeTab === "my"
            ? "text-white border-b-2 border-blue-500"
            : "text-sol-base0 hover:text-white"
        }`}
      >
        My Conversations
      </button>
      <button
        onClick={() => handleTabChange("team")}
        className={`pb-3 text-sm font-medium transition-colors ${
          activeTab === "team"
            ? "text-white border-b-2 border-blue-500"
            : "text-sol-base0 hover:text-white"
        }`}
      >
        Team
      </button>
    </div>
  );
}
