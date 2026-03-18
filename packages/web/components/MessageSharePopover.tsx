interface MessageSharePopoverProps {
  messageId: string;
  onStartShareSelection: (messageId: string) => void;
  trigger: React.ReactNode;
}

export function MessageSharePopover({
  messageId,
  onStartShareSelection,
  trigger,
}: MessageSharePopoverProps) {
  return (
    <button
      onClick={() => onStartShareSelection(messageId)}
      className="flex items-center"
    >
      {trigger}
    </button>
  );
}
