import { useState, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useShortcutContext, useShortcutAction } from "../shortcuts";

interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  changes: DiffLine[];
}

interface DiffLine {
  type: "context" | "addition" | "deletion";
  oldLine?: number;
  newLine?: number;
  content: string;
}

interface CommentDraft {
  filePath: string;
  lineNumber: number;
  content: string;
}

export function ReviewView({ prId }: { prId: string }) {
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submitReview = useAction(api.reviews.submitReview);

  const mockPR = {
    title: "Add Header component improvements",
    number: 123,
    repository: "my-org/my-repo",
  };

  const mockDiffs: FileDiff[] = [
    {
      path: "src/components/Header.tsx",
      additions: 5,
      deletions: 2,
      changes: [
        { type: "context", oldLine: 1, newLine: 1, content: "import React from 'react';" },
        { type: "context", oldLine: 2, newLine: 2, content: "" },
        { type: "deletion", oldLine: 3, content: "export function Header() {" },
        { type: "addition", newLine: 3, content: "export function Header({ title }: { title: string }) {" },
        { type: "context", oldLine: 4, newLine: 4, content: "  return (" },
        { type: "deletion", oldLine: 5, content: "    <h1>My App</h1>" },
        { type: "addition", newLine: 5, content: "    <h1>{title}</h1>" },
        { type: "context", oldLine: 6, newLine: 6, content: "  );" },
        { type: "context", oldLine: 7, newLine: 7, content: "}" },
      ],
    },
    {
      path: "src/utils/api.ts",
      additions: 8,
      deletions: 0,
      changes: [
        { type: "context", oldLine: 1, newLine: 1, content: "export const API_BASE = 'https://api.example.com';" },
        { type: "context", oldLine: 2, newLine: 2, content: "" },
        { type: "addition", newLine: 3, content: "export async function fetchUser(id: string) {" },
        { type: "addition", newLine: 4, content: "  const response = await fetch(`${API_BASE}/users/${id}`);" },
        { type: "addition", newLine: 5, content: "  return response.json();" },
        { type: "addition", newLine: 6, content: "}" },
      ],
    },
    {
      path: "README.md",
      additions: 3,
      deletions: 1,
      changes: [
        { type: "context", oldLine: 1, newLine: 1, content: "# My Project" },
        { type: "context", oldLine: 2, newLine: 2, content: "" },
        { type: "deletion", oldLine: 3, content: "A simple project." },
        { type: "addition", newLine: 3, content: "A simple project for demonstrating code reviews." },
        { type: "addition", newLine: 4, content: "" },
        { type: "addition", newLine: 5, content: "## Features" },
        { type: "context", oldLine: 4, newLine: 6, content: "" },
      ],
    },
  ];

  const currentFile = mockDiffs[currentFileIndex];

  useShortcutContext('review');

  useShortcutAction('review.nextFile', useCallback(() => {
    if (commentDraft) return false;
    setCurrentFileIndex((prev) => Math.min(prev + 1, mockDiffs.length - 1));
  }, [commentDraft, mockDiffs.length]));

  useShortcutAction('review.prevFile', useCallback(() => {
    if (commentDraft) return false;
    setCurrentFileIndex((prev) => Math.max(prev - 1, 0));
  }, [commentDraft]));

  useShortcutAction('review.comment', useCallback(() => {
    if (commentDraft) return false;
    const firstLine = currentFile.changes.find((c) => c.newLine);
    if (firstLine?.newLine) {
      setCommentDraft({
        filePath: currentFile.path,
        lineNumber: firstLine.newLine,
        content: "",
      });
    }
  }, [currentFile, commentDraft]));

  useShortcutAction('ui.toggleShortcutsHelp', useCallback(() => {
    setShowShortcuts((prev) => !prev);
  }, []));

  const handleLineClick = (lineNumber: number | undefined) => {
    if (!lineNumber) return;
    setCommentDraft({
      filePath: currentFile.path,
      lineNumber,
      content: "",
    });
  };

  const handleCommentSubmit = () => {
    if (!commentDraft?.content.trim()) return;
    setCommentDraft(null);
  };

  const handleCommentCancel = () => {
    setCommentDraft(null);
  };

  const handleApprove = async () => {
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await submitReview({
        pull_request_id: prId as any,
        reviewer_user_id: "mock-user-id" as any,
        event: "APPROVE",
        body: "Looks good!",
        github_access_token: "mock-token",
      });
      setSuccess("PR approved successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve PR");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestChanges = async () => {
    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await submitReview({
        pull_request_id: prId as any,
        reviewer_user_id: "mock-user-id" as any,
        event: "REQUEST_CHANGES",
        body: "Please address the comments.",
        github_access_token: "mock-token",
      });
      setSuccess("Changes requested successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request changes");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-sol-bg">
      <div className="sol-header px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-sol-text">
                {mockPR.title}
              </h1>
              <span className="text-sm text-sol-text-muted">
                #{mockPR.number}
              </span>
            </div>
            <div className="text-sm text-sol-text-secondary mt-1">
              {mockPR.repository}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleApprove}
              disabled={isSubmitting}
              className="sol-btn-primary bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Submitting..." : "Approve"}
            </button>
            <button
              onClick={handleRequestChanges}
              disabled={isSubmitting}
              className="sol-btn-primary bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Submitting..." : "Request Changes"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded text-sm text-green-600 dark:text-green-400">
            {success}
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="sol-sidebar w-64 flex-shrink-0 overflow-y-auto p-4">
          <h2 className="text-sm font-semibold text-sol-text mb-3">
            Files Changed ({mockDiffs.length})
          </h2>
          <div className="space-y-1">
            {mockDiffs.map((file, index) => (
              <button
                key={file.path}
                onClick={() => setCurrentFileIndex(index)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  index === currentFileIndex
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
                }`}
              >
                <div className="font-mono text-xs truncate">
                  {file.path}
                </div>
                <div className="flex gap-2 mt-1 text-xs">
                  <span className="text-green-500">+{file.additions}</span>
                  <span className="text-red-500">-{file.deletions}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="sol-card p-4">
            <div className="mb-4 pb-3 border-b border-sol-border">
              <h3 className="font-mono text-sm text-sol-text">
                {currentFile.path}
              </h3>
              <div className="flex gap-3 mt-2 text-xs">
                <span className="text-green-500">
                  +{currentFile.additions} additions
                </span>
                <span className="text-red-500">
                  -{currentFile.deletions} deletions
                </span>
              </div>
            </div>

            <div className="font-mono text-sm">
              {currentFile.changes.map((line, idx) => {
                const lineNumber = line.newLine ?? line.oldLine;
                const isCommentLine =
                  commentDraft?.filePath === currentFile.path &&
                  commentDraft?.lineNumber === lineNumber;

                return (
                  <div key={idx}>
                    <div
                      onClick={() => handleLineClick(lineNumber)}
                      className={`flex hover:bg-sol-bg-highlight/30 cursor-pointer ${
                        line.type === "addition"
                          ? "bg-green-500/10"
                          : line.type === "deletion"
                          ? "bg-red-500/10"
                          : ""
                      }`}
                    >
                      <div className="w-12 text-right px-2 py-0.5 text-sol-text-dim select-none flex-shrink-0">
                        {lineNumber}
                      </div>
                      <div className="w-8 px-2 py-0.5 flex-shrink-0 select-none">
                        {line.type === "addition" && (
                          <span className="text-green-500">+</span>
                        )}
                        {line.type === "deletion" && (
                          <span className="text-red-500">-</span>
                        )}
                      </div>
                      <div
                        className={`flex-1 px-2 py-0.5 ${
                          line.type === "addition"
                            ? "text-green-600 dark:text-green-400"
                            : line.type === "deletion"
                            ? "text-red-600 dark:text-red-400"
                            : "text-sol-text-secondary"
                        }`}
                      >
                        {line.content || " "}
                      </div>
                    </div>

                    {isCommentLine && (
                      <div className="bg-amber-500/10 border-l-2 border-amber-500 p-3 ml-20 mb-2">
                        <textarea
                          autoFocus
                          value={commentDraft.content}
                          onChange={(e) =>
                            setCommentDraft({
                              ...commentDraft,
                              content: e.target.value,
                            })
                          }
                          placeholder="Add a comment..."
                          className="w-full sol-input text-sm resize-none"
                          rows={3}
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={handleCommentSubmit}
                            className="sol-btn-primary"
                            disabled={!commentDraft.content.trim()}
                          >
                            Add comment
                          </button>
                          <button
                            onClick={handleCommentCancel}
                            className="sol-btn-ghost"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {showShortcuts && (
        <div className="sol-header px-4 py-2 text-xs text-sol-text-muted">
          <div className="flex gap-6">
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                j
              </kbd>{" "}
              next file
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                k
              </kbd>{" "}
              prev file
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                c
              </kbd>{" "}
              comment
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                ?
              </kbd>{" "}
              toggle shortcuts
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
