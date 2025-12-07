interface UserMessageProps {
  content: string;
  timestamp: number;
}

export function UserMessage({ content, timestamp }: UserMessageProps) {
  return (
    <div className="flex justify-end mb-4">
      <div className="max-w-[80%]">
        <div className="bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-3">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
        <p className="text-xs text-sol-base00 mt-1 text-right">
          {new Date(timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
