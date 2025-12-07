"use client";

interface AssistantMessageProps {
  content: string;
  timestamp: number;
}

export function AssistantMessage({ content, timestamp }: AssistantMessageProps) {
  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[80%]">
        <div className="bg-slate-700 text-sol-base2 rounded-2xl rounded-bl-md px-4 py-3">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
        <p className="text-xs text-sol-base00 mt-1">
          {new Date(timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
