'use client';

import { FileChange, useDiffViewerStore } from '@/store/diffViewerStore';
import { useState } from 'react';

interface VerticalTimelineProps {
  onSelectChange?: (index: number) => void;
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getColorForFile(filePath: string): string {
  const hue = hashString(filePath) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function VerticalTimeline({ onSelectChange }: VerticalTimelineProps) {
  const changes = useDiffViewerStore((state) => state.changes);
  const selectedChangeIndex = useDiffViewerStore((state) => state.selectedChangeIndex);
  const selectChange = useDiffViewerStore((state) => state.selectChange);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const handleDotClick = (index: number) => {
    selectChange(index);
    onSelectChange?.(index);
  };

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className="relative flex flex-col items-center w-10 h-full bg-gray-50 dark:bg-gray-900 border-x border-gray-200 dark:border-gray-800 overflow-y-auto">
      <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-gray-300 dark:bg-gray-700 -translate-x-1/2" />

      <div className="relative flex flex-col items-center py-4 gap-3 w-full">
        {changes.map((change, index) => {
          const isSelected = selectedChangeIndex === index;
          const isHovered = hoveredIndex === index;
          const color = getColorForFile(change.filePath);

          return (
            <div
              key={change.id}
              className="relative z-10 group"
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <button
                onClick={() => handleDotClick(index)}
                className={`
                  w-3 h-3 rounded-full transition-all duration-200
                  ${isSelected ? 'w-4 h-4 ring-2 ring-offset-2 ring-offset-gray-50 dark:ring-offset-gray-900' : ''}
                  ${isHovered ? 'scale-125' : ''}
                  hover:scale-125 focus:outline-none focus:scale-125
                `}
                style={{
                  backgroundColor: color,
                  boxShadow: isSelected ? `0 0 8px ${color}` : 'none',
                }}
                aria-label={`Change ${index + 1}: ${change.filePath}`}
              />

              {isHovered && (
                <div className="absolute left-12 top-1/2 -translate-y-1/2 z-50 pointer-events-none">
                  <div className="bg-gray-900 dark:bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-nowrap border border-gray-700">
                    <div className="font-semibold">{change.filePath}</div>
                    <div className="text-gray-300 mt-1">
                      {change.changeType === 'write' ? 'Write' : 'Edit'} • {formatTimestamp(change.timestamp)}
                    </div>
                    <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 w-2 h-2 bg-gray-900 dark:bg-gray-800 rotate-45 border-l border-b border-gray-700" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
