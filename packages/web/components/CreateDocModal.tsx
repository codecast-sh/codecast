import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMentionQuery } from "../hooks/useMentionQuery";
import { useImageUpload } from "../hooks/useImageUpload";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";
import { DocEditor } from "./editor/DocEditor";

const api = _api as any;

const DOC_TYPES = [
  { value: "note", label: "Note" },
  { value: "spec", label: "Spec" },
  { value: "design", label: "Design" },
  { value: "plan", label: "Plan" },
  { value: "investigation", label: "Investigation" },
  { value: "handoff", label: "Handoff" },
] as const;

const FIDELITY_OPTIONS = [
  { value: "", label: "Auto (default)" },
  { value: "full", label: "Full" },
  { value: "compact", label: "Compact" },
  { value: "summary_high", label: "Summary (high)" },
  { value: "summary_medium", label: "Summary (medium)" },
  { value: "summary_low", label: "Summary (low)" },
  { value: "truncate", label: "Truncate" },
];

const JOIN_POLICY_OPTIONS = [
  { value: "", label: "Default (wait_all)" },
  { value: "wait_all", label: "Wait All" },
  { value: "first_success", label: "First Success" },
  { value: "k_of_n", label: "K of N" },
  { value: "quorum", label: "Quorum (>50%)" },
];

export function CreateDocModal({ onClose, initialType }: { onClose: () => void; initialType?: string }) {
  const router = useRouter();
  const createDoc = useMutation(api.docs.webCreate);
  const createPlan = useMutation(api.plans.webCreate);
  const handleMentionQuery = useMentionQuery();
  const handleImageUpload = useImageUpload();

  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState(initialType || "note");
  const contentRef = useRef("");
  const [submitting, setSubmitting] = useState(false);

  const [goal, setGoal] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelStylesheet, setModelStylesheet] = useState("");
  const [fidelity, setFidelity] = useState("");
  const [joinPolicy, setJoinPolicy] = useState("");
  const [joinK, setJoinK] = useState("");
  const [acceptance, setAcceptance] = useState("");

  const isPlan = docType === "plan";
  const selectClass = "w-full text-xs px-2 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text focus:outline-none focus:border-sol-cyan appearance-none";

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (isPlan) {
        const criteria = acceptance.trim()
          ? acceptance.trim().split("\n").filter(Boolean)
          : undefined;
        const desc = contentRef.current.trim();
        const goalText = [goal.trim(), desc].filter(Boolean).join("\n\n") || undefined;
        const result = await createPlan({
          title: title.trim(),
          goal: goalText,
          status: "active",
          model_stylesheet: modelStylesheet.trim() || undefined,
          fidelity: fidelity || undefined,
          join_policy: joinPolicy || undefined,
          join_k: joinPolicy === "k_of_n" && joinK ? parseInt(joinK, 10) : undefined,
          acceptance_criteria: criteria,
        });
        toast.success("Plan created");
        onClose();
        if (result?.short_id) router.push(`/plans/${result.short_id}`);
      } else {
        const content = contentRef.current.trim();
        const result = await createDoc({ title: title.trim(), content, doc_type: docType });
        toast.success(`Created: ${title.trim()}`);
        onClose();
        if (result?.id) router.push(`/docs/${result.id}`);
      }
    } catch {
      toast.error(isPlan ? "Failed to create plan" : "Failed to create doc");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-start justify-center pt-[10vh] animate-in fade-in duration-150"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
      }}
    >
      <div
        className="bg-sol-bg border border-sol-border rounded-2xl shadow-2xl w-full max-w-[640px] animate-in slide-in-from-bottom-4 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isPlan ? "Plan title" : "Doc title"}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault();
              if (e.key === "Escape") onClose();
            }}
            className="w-full text-xl font-semibold text-sol-text placeholder:text-sol-text-dim/40 bg-transparent outline-none"
          />
        </div>

        {isPlan && (
          <div className="px-6 pb-2">
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
              placeholder="Goal (optional)"
              className="w-full text-sm text-sol-text-muted placeholder:text-sol-text-dim/30 bg-transparent outline-none"
            />
          </div>
        )}

        <div className="px-6 pb-4 min-h-[300px] max-h-[50vh] overflow-y-auto doc-editor-compact">
          <DocEditor
            content=""
            onUpdate={(md) => { contentRef.current = md; }}
            onMentionQuery={handleMentionQuery}
            onImageUpload={handleImageUpload}
            placeholder={isPlan ? "Add details... use @ to mention, paste images" : "Start writing... use @ to mention, paste images"}
            className="text-sm"
          />
        </div>

        <div className="flex items-center gap-2 px-6 py-3 border-t border-sol-border/40 flex-wrap">
          {DOC_TYPES.map((dt) => (
            <button
              key={dt.value}
              onClick={() => setDocType(dt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                docType === dt.value
                  ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-text"
                  : "border-sol-border/30 text-sol-text-dim hover:text-sol-text-muted"
              }`}
            >
              {dt.label}
            </button>
          ))}
        </div>

        {isPlan && (
          <div className="px-6 pb-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`} />
              Workflow config
            </button>

            {showAdvanced && (
              <div className="space-y-2 pl-1 border-l-2 border-sol-border/20 ml-1 mt-2">
                <div>
                  <label className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide">Acceptance Criteria</label>
                  <textarea
                    value={acceptance}
                    onChange={(e) => setAcceptance(e.target.value)}
                    placeholder={"One criterion per line...\ne.g. All tests pass\ne.g. No new lint warnings"}
                    rows={3}
                    className="w-full text-xs px-2 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim/50 focus:outline-none focus:border-sol-cyan resize-none mt-0.5 font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide">Model Stylesheet</label>
                  <textarea
                    value={modelStylesheet}
                    onChange={(e) => setModelStylesheet(e.target.value)}
                    placeholder={"CSS-like model routing rules...\ne.g. * { model: sonnet }\n#planning { model: opus }"}
                    rows={3}
                    className="w-full text-xs px-2 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim/50 focus:outline-none focus:border-sol-cyan resize-none mt-0.5 font-mono"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide">Fidelity</label>
                    <select value={fidelity} onChange={(e) => setFidelity(e.target.value)} className={selectClass + " mt-0.5"}>
                      {FIDELITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide">Join Policy</label>
                    <select value={joinPolicy} onChange={(e) => setJoinPolicy(e.target.value)} className={selectClass + " mt-0.5"}>
                      {JOIN_POLICY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  {joinPolicy === "k_of_n" && (
                    <div className="w-16">
                      <label className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide">K</label>
                      <input
                        type="number"
                        min={1}
                        value={joinK}
                        onChange={(e) => setJoinK(e.target.value)}
                        placeholder="K"
                        className="w-full text-xs px-2 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text focus:outline-none focus:border-sol-cyan mt-0.5"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-sol-border/40">
          <span className="text-[11px] text-sol-text-dim/50 mr-1 hidden sm:inline">
            {typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent) ? "\u2318" : "Ctrl"}+&#x21B5;
          </span>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg text-sol-text-muted hover:text-sol-text transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="px-5 py-2 text-sm rounded-lg bg-sol-cyan text-sol-bg font-semibold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? "Creating..." : isPlan ? "Create plan" : "Create doc"}
          </button>
        </div>
      </div>
    </div>
  );
}
