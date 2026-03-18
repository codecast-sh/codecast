import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Switch } from "./ui/switch";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: Id<"conversations">;
  conversationTitle?: string;
  shareToken?: string;
  onShareGenerated?: (token: string) => void;
}

export function ShareDialog({
  open,
  onOpenChange,
  conversationId,
  conversationTitle,
  shareToken: initialShareToken,
  onShareGenerated,
}: ShareDialogProps) {
  const [shareToken, setShareToken] = useState(initialShareToken);
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState(conversationTitle || "");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const publishToDirectory = useMutation(api.conversations.publishToDirectory);

  const shareUrl = shareToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/share/${shareToken}`
    : "";

  const handleShare = async () => {
    try {
      if (!shareToken) {
        const token = await generateShareLink({ conversation_id: conversationId });
        setShareToken(token);
        onShareGenerated?.(token);
      }

      if (isPublic && title.trim()) {
        const tagArray = tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        await publishToDirectory({
          conversation_id: conversationId,
          title: title.trim(),
          description: description.trim() || undefined,
          tags: tagArray.length > 0 ? tagArray : undefined,
        });

        toast.success("Conversation published to directory");
      }

      if (shareUrl) {
        await copyToClipboard(shareUrl);
        toast.success("Share link copied to clipboard");
      }

      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to share");
    }
  };

  const handleCopyLink = async () => {
    if (shareUrl) {
      await copyToClipboard(shareUrl);
      toast.success("Link copied to clipboard");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-sol-bg border-sol-border">
        <DialogHeader>
          <DialogTitle className="text-sol-text">Share Conversation</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {shareUrl && (
            <div className="space-y-2">
              <Label className="text-sol-text-secondary">Share link</Label>
              <div className="flex gap-2">
                <Input
                  value={shareUrl}
                  readOnly
                  className="bg-sol-bg-alt border-sol-border text-sol-text-dim font-mono text-sm"
                />
                <Button
                  onClick={handleCopyLink}
                  variant="outline"
                  className="bg-sol-bg border-sol-border text-sol-text-secondary hover:bg-sol-bg-alt"
                >
                  Copy
                </Button>
              </div>
            </div>
          )}

          <div className="h-px bg-sol-border" />

          <div className="flex items-center gap-3">
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
            <Label className="text-sol-text-secondary cursor-pointer" onClick={() => setIsPublic(!isPublic)}>
              List in public directory
            </Label>
          </div>

          {isPublic && (
            <div className="space-y-4 pl-2 border-l-2 border-sol-cyan/30">
              <div className="space-y-2">
                <Label htmlFor="title" className="text-sol-text-secondary">
                  Title
                </Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Give your conversation a descriptive title"
                  className="bg-sol-bg-alt border-sol-border text-sol-text"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description" className="text-sol-text-secondary">
                  Description (optional)
                </Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What makes this conversation useful?"
                  className="bg-sol-bg-alt border-sol-border text-sol-text min-h-[80px]"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tags" className="text-sol-text-secondary">
                  Tags (optional)
                </Label>
                <Input
                  id="tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="react, typescript, debugging (comma-separated)"
                  className="bg-sol-bg-alt border-sol-border text-sol-text"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="bg-sol-bg border-sol-border text-sol-text-secondary hover:bg-sol-bg-alt"
            >
              Cancel
            </Button>
            <Button
              onClick={handleShare}
              className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
            >
              {isPublic ? "Share & List Publicly" : "Share"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
