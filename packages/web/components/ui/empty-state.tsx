import * as React from "react"

import { cn } from "../../lib/utils"
import { Button } from "./button"

type Icon = React.ComponentType<{ className?: string }>

/** A press: a label and a handler, with an optional leading icon. */
export interface EmptyStateAction {
  label: string
  onClick: () => void
  icon?: Icon
}

export interface EmptyStateProps {
  /** The subject's own icon, chosen by the caller (a list of tasks shows the
   *  task icon, never a generic bubble). */
  icon: Icon
  /** What is empty, in five words or fewer ("No tasks yet"). No sentence
   *  goes under it: the action says what to do next. */
  title: string
  /** The one primary action. A handler, or a ready element when the action
   *  is a link: `<Button asChild size="sm"><Link href="/x">Open</Link></Button>`
   *  (this file stays free of the app's router so a share page can use it). */
  action?: EmptyStateAction | React.ReactElement
  /** A quieter second way out, drawn as a link. */
  secondary?: EmptyStateAction | React.ReactElement
  /** `panel` centres in the space it is given; `inline` is one row inside a
   *  list or a card. */
  size?: "panel" | "inline"
  className?: string
  /** Data rather than copy, opened on demand: an error's details behind a
   *  disclosure, say. */
  children?: React.ReactNode
}

function Press({ action, look }: { action: EmptyStateAction | React.ReactElement; look: "primary" | "inline" | "secondary" }) {
  if (React.isValidElement(action)) return action
  const { label, onClick, icon: ActionIcon } = action
  const variant = look === "primary" ? "primary" : look === "inline" ? "ghost" : "link"
  return (
    <Button
      type="button"
      variant={variant}
      size={look === "primary" ? "sm" : "xs"}
      onClick={onClick}
      className={look === "secondary" ? "text-sol-text-muted hover:text-sol-text" : undefined}
    >
      {ActionIcon && <ActionIcon />}
      {label}
    </Button>
  )
}

/** The one empty state: an icon, a short title, at most one primary button
 *  and one secondary link. Also what an error boundary draws (ErrorBoundary)
 *  and what a page shows when there is nothing yet. */
export function EmptyState({ icon: Icon, title, action, secondary, size = "panel", className, children }: EmptyStateProps) {
  if (size === "inline") {
    return (
      <div data-empty-state="inline" className={cn("flex min-h-control-md items-center gap-2 px-3 py-1.5 text-ui text-sol-text-dim", className)}>
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
        {(action || secondary) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {action && <Press action={action} look="inline" />}
            {secondary && <Press action={secondary} look="secondary" />}
          </span>
        )}
        {children}
      </div>
    )
  }
  return (
    <div data-empty-state="panel" className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <span className="flex size-10 items-center justify-center rounded-card bg-sol-text/[0.05] text-sol-text-dim">
        <Icon className="size-5" />
      </span>
      <p className="max-w-sm text-body font-medium text-sol-text">{title}</p>
      {(action || secondary) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {action && <Press action={action} look="primary" />}
          {secondary && <Press action={secondary} look="secondary" />}
        </div>
      )}
      {children}
    </div>
  )
}
