"use client";
import { Check, Circle, Loader2 } from "lucide-react";
import type { ToolViewProps } from "@/lib/toolRegistry";

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  priority?: 'high' | 'medium' | 'low';
  id?: string;
}

function TodoItem({ todo }: { todo: Todo }) {
  const getIcon = () => {
    switch (todo.status) {
      case 'completed':
        return <Check className="w-4 h-4 text-emerald-500" />;
      case 'in_progress':
        return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
      default:
        return <Circle className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getTextStyle = () => {
    switch (todo.status) {
      case 'completed':
        return 'line-through text-muted-foreground';
      case 'in_progress':
        return 'text-blue-400 font-medium';
      default:
        return 'text-foreground/90';
    }
  };

  const getPriorityBadge = () => {
    if (!todo.priority || todo.priority === 'medium') return null;

    const colors = {
      high: 'bg-red-500/20 text-red-400 border-red-500/30',
      low: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
    };

    return (
      <span className={`text-xs px-1.5 py-0.5 rounded border ${colors[todo.priority]}`}>
        {todo.priority}
      </span>
    );
  };

  return (
    <div className="flex items-start gap-3 p-2 rounded hover:bg-muted/30 transition-colors">
      <div className="mt-0.5">
        {getIcon()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm ${getTextStyle()}`}>
            {todo.content}
          </span>
          {getPriorityBadge()}
        </div>
        {todo.activeForm && todo.status === 'in_progress' && (
          <div className="text-xs text-muted-foreground mt-1">
            {todo.activeForm}
          </div>
        )}
      </div>
    </div>
  );
}

export function TodoToolView({ input, output }: ToolViewProps) {
  const todos: Todo[] = input?.todos || output?.newTodos || [];

  if (todos.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground italic">
        No todos
      </div>
    );
  }

  const pendingCount = todos.filter(t => t.status === 'pending').length;
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
  const completedCount = todos.filter(t => t.status === 'completed').length;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>
          <span className="text-emerald-500 font-semibold">{completedCount}</span> completed
        </span>
        <span>
          <span className="text-blue-500 font-semibold">{inProgressCount}</span> in progress
        </span>
        <span>
          <span className="text-foreground/70 font-semibold">{pendingCount}</span> pending
        </span>
      </div>

      <div className="space-y-1">
        {todos.map((todo, i) => (
          <TodoItem key={todo.id || i} todo={todo} />
        ))}
      </div>
    </div>
  );
}
