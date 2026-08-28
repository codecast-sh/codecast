import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { Check, ArrowRight, ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { TeamIcon } from "./TeamIcon";
import { VisibilityPicker, type TeamVisibility } from "./team/VisibilityPicker";
import { WorkspaceSharePicker, useWorkspaceSelection } from "./team/WorkspaceSharePicker";
import { useTeamWorkspaceSuggestions } from "../hooks/useTeamWorkspaceSuggestions";
import { useSaveTeamSetup } from "../lib/team/saveTeamSetup";

export function TeamSetupDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setupTeamId = (searchParams.get("teamId") as Id<"teams"> | null) || null;
  const teamSetupRequested = searchParams.get("teamSetup") === "1";

  const data = useTeamWorkspaceSuggestions(setupTeamId);
  const { suggestions, allProjects, teamName } = data;
  const { selectedPaths, toggle: toggleWorkspace, selectedCount } =
    useWorkspaceSelection(data, setupTeamId);
  const save = useSaveTeamSetup();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"visibility" | "projects">("visibility");
  const [visibility, setVisibility] = useState<TeamVisibility>("full");
  const [saving, setSaving] = useState(false);

  // Open dialog when URL params are present
  useEffect(() => {
    if (teamSetupRequested && setupTeamId) {
      setOpen(true);
    }
  }, [teamSetupRequested, setupTeamId]);

  // Seed defaults from backend
  useEffect(() => {
    if (!suggestions) return;
    setVisibility(suggestions.current_visibility || "summary");
  }, [suggestions?.team_id, suggestions?.current_visibility]);

  const close = () => {
    setOpen(false);
    setStep("visibility");
    if (!teamSetupRequested) return;
    // Consume the handoff params off the CURRENT URL — this dialog renders
    // inside the settings modal over whatever page initiated team setup.
    const next = new URLSearchParams(searchParams.toString());
    next.delete("teamSetup");
    next.delete("teamId");
    const q = next.toString();
    router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`);
  };

  const handleSave = async () => {
    if (!setupTeamId) {
      close();
      return;
    }
    setSaving(true);
    try {
      const { mapped } = await save({ teamId: setupTeamId, visibility, selectedPaths, allProjects });
      const name = suggestions?.team_name || "team";
      if (mapped > 0) {
        toast.success(`Sharing ${mapped} workspace${mapped === 1 ? "" : "s"} with ${name}`);
      } else {
        toast.success(`Saved ${name} settings`);
      }
      close();
    } catch (err) {
      console.error("Team setup save failed:", err);
      toast.error("Failed to save team setup");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="bg-sol-bg border-sol-border max-w-2xl max-h-[85vh] overflow-hidden flex flex-col p-0">
        {/* Step indicator */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-2">
          <StepIndicator
            number={1}
            label="Visibility"
            active={step === "visibility"}
            completed={step === "projects"}
          />
          <div className="h-px flex-1 bg-sol-border" />
          <StepIndicator
            number={2}
            label="Workspaces"
            active={step === "projects"}
            completed={false}
          />
        </div>

        {step === "visibility" ? (
          <>
            <DialogHeader className="px-6 pt-2">
              <div className="flex items-center gap-3 mb-1">
                {suggestions?.team_icon && (
                  <div className="w-9 h-9 rounded-lg bg-sol-bg-alt border border-sol-border flex items-center justify-center">
                    <TeamIcon
                      icon={suggestions.team_icon}
                      color={suggestions.team_icon_color}
                      className="w-5 h-5"
                    />
                  </div>
                )}
                <DialogTitle className="text-sol-text text-xl">
                  Welcome to {teamName}
                </DialogTitle>
              </div>
              <DialogDescription className="text-sol-base1 text-sm">
                Choose how your work appears to teammates. This controls what
                they see in the team feed. You can change it anytime.
              </DialogDescription>
            </DialogHeader>

            <VisibilityPicker
              value={visibility}
              onChange={setVisibility}
              className="flex-1 overflow-y-auto px-6 py-3"
            />

            <DialogFooter className="px-6 pb-6 pt-3 border-t border-sol-border gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={close}
                className="border-sol-border text-sol-base1"
              >
                Skip for now
              </Button>
              <Button
                onClick={() => setStep("projects")}
                className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 gap-1.5"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="px-6 pt-2">
              <DialogTitle className="text-sol-text text-lg">
                Share workspaces with {teamName}
              </DialogTitle>
              <DialogDescription className="text-sol-base1 text-sm">
                Select workspaces to automatically share with the team. New
                sessions in shared workspaces will appear in the team feed.
              </DialogDescription>
            </DialogHeader>

            <WorkspaceSharePicker
              data={data}
              teamId={setupTeamId}
              selectedPaths={selectedPaths}
              onToggle={toggleWorkspace}
              className="flex-1 overflow-y-auto px-6 py-2 min-h-0"
            />

            <DialogFooter className="px-6 pb-6 pt-3 border-t border-sol-border gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setStep("visibility")}
                className="border-sol-border text-sol-base1 gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
              <div className="flex items-center gap-3 sm:ml-auto">
                <span className="text-xs text-sol-base01">
                  {selectedCount} workspace{selectedCount === 1 ? "" : "s"} selected
                </span>
                <Button
                  onClick={handleSave}
                  disabled={saving || !setupTeamId}
                  className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
                >
                  {saving ? "Saving..." : "Save & Start"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Step indicator dot ──────────────────────────────────────────────

function StepIndicator({
  number,
  label,
  active,
  completed,
}: {
  number: number;
  label: string;
  active: boolean;
  completed: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
          active
            ? "bg-sol-cyan text-sol-bg"
            : completed
              ? "bg-sol-cyan/20 text-sol-cyan"
              : "bg-sol-bg-alt text-sol-base01 border border-sol-border"
        }`}
      >
        {completed ? <Check className="w-3.5 h-3.5" /> : number}
      </div>
      <span
        className={`text-xs font-medium ${
          active ? "text-sol-text" : "text-sol-base01"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
