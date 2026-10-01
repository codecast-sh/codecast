import { forwardRef, type FormEventHandler, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { ComposerFade } from "./ComposerFade";
import { composerColumn, FIELD_SIZING_STYLE } from "./composerLayout";

/**
 * The composer as markup: the sticky frame, the status line, and the bordered
 * field. MessageInput owns every behaviour (drafts, send, autocomplete,
 * uploads) and fills the slots; the marketing hero fills them with a fixture
 * draft. Slots render in document order.
 */
export function ComposerShell({
  rootRef,
  inline = false,
  bare = false,
  expanded = false,
  lightboxOpen = false,
  composeMode = false,
  selectionActive = false,
  onSubmit,
  before,
  meta,
  metaEnd,
  between,
  fieldTop,
  children,
  foot,
  after,
}: {
  rootRef?: Ref<HTMLDivElement>;
  /** Sits in another surface: no sticky frame, fade or column padding. */
  inline?: boolean;
  /** The comment-style box: no status line, no border. */
  bare?: boolean;
  /** The conversation's full column instead of the resting pill. */
  expanded?: boolean;
  /** An attached image is previewed over the page; the chrome steps back. */
  lightboxOpen?: boolean;
  /** The rich editor is open in place of the textarea. */
  composeMode?: boolean;
  /** A message is being rewritten, so the field wears the cyan ring. */
  selectionActive?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  /** Above the status line (banners, the compaction card). */
  before?: ReactNode;
  /** The status line's left side: what the session is doing now. */
  meta?: ReactNode;
  /** The status line's right side (the permission mode dot). */
  metaEnd?: ReactNode;
  /** Between the status line and the field (thread state, menus). */
  between?: ReactNode;
  /** Inside the field, above the text row (queue, images, review quotes). */
  fieldTop?: ReactNode;
  /** The text row: usually a ComposerTextRow. */
  children: ReactNode;
  /** A toolbar row under the field, usually a ComposerFoot. Inside the form,
   *  so a send button placed there still submits. */
  foot?: ReactNode;
  /** After the frame (the image lightbox portal). */
  after?: ReactNode;
}) {
  const { colClass } = composerColumn({ inline, expanded });
  return (
    <div ref={rootRef} data-sv-composer className={`shrink-0 pointer-events-none ${inline ? "" : "sticky bottom-0"} ${lightboxOpen ? "z-[10002]" : "z-10"}`}>
      {!lightboxOpen && !inline && <ComposerFade />}
      <div className={`${inline ? "" : bare ? "pb-4" : "pb-3"} pointer-events-auto ${!lightboxOpen && !inline ? "bg-sol-bg" : ""}`}>
        <div className="relative">
          {before}
          {/* The composer's status line: always one row tall, so focusing the
              box or the agent changing state never shifts the composer. The
              left side carries the live status (or nothing); the right side
              is the send-options "?" and the permission mode dot. */}
          {!bare && (
            <div data-cc-composer-meta className={`mx-auto mb-1 min-h-[18px] flex justify-between items-center ${colClass} ${lightboxOpen ? "hidden" : ""}`}>
              <p className="text-[11px] text-sol-text-dim/70 pl-1">
                {meta}
              </p>
              <div className="flex items-center gap-2">
                {metaEnd}
              </div>
            </div>
          )}
          {between}
          <form onSubmit={onSubmit} className={bare ? "w-full" : `mx-auto ${colClass}`}>
            <div data-composer-field={composeMode ? "" : undefined} className={`flex flex-col ${bare ? "" : "border"} transition-colors duration-150 ${bare ? "px-2.5 py-0.5 rounded-lg bg-sol-text/[0.04] focus-within:bg-sol-text/[0.07]" : inline ? "border px-3 py-1.5 rounded-xl bg-sol-bg-alt" : `border px-4 py-2 shadow-lg bg-sol-bg-alt ${expanded ? "rounded-2xl" : "rounded-full"}`} ${composeMode ? "min-h-[min(40vh,var(--composer-max-h,40vh))] max-h-[var(--composer-max-h,45vh)]" : ""} ${selectionActive ? "border-sol-cyan/40 ring-1 ring-sol-cyan/20" : composeMode ? "border-sol-cyan/20" : bare ? "" : "border-sol-border"}`}>
              {fieldTop}
              {children}
            </div>
            {foot}
          </form>
        </div>
      </div>
      {after}
    </div>
  );
}

/**
 * The resting text row: the textarea (and anything sharing its grid cell,
 * like the ghost suggestion) on the left, the send cluster on the right.
 * `tucked` drops the cluster onto its own line when the row is too narrow.
 */
export function ComposerTextRow({
  rowRef,
  sendRef,
  tucked = false,
  actions,
  send,
  children,
}: {
  rowRef?: Ref<HTMLDivElement>;
  sendRef?: Ref<HTMLDivElement>;
  tucked?: boolean;
  /** Buttons before send (expand, stash, hand off, fork). */
  actions?: ReactNode;
  /** Usually a ComposerSendButton. Absent when a ComposerFoot carries it. */
  send?: ReactNode;
  /** A ComposerTextarea, plus anything that overlays it in the same cell. */
  children: ReactNode;
}) {
  return (
    <div ref={rowRef} className="flex flex-wrap items-end gap-x-2 gap-y-1">
      {/* One grid cell for the textarea and the ghost suggestion: the
          cell takes the taller of the two, so a wrapped suggestion
          grows the box and the textarea stretches to cover it. */}
      <div className="grid flex-1 min-w-0">
        {children}
      </div>
      {(actions || send) && (
        <div ref={sendRef} className={`shrink-0 flex items-center gap-1 ${tucked ? "basis-full justify-end" : ""}`}>
          {actions}
          {send}
        </div>
      )}
    </div>
  );
}

/**
 * The toolbar row under a framed composer (team chat, a thread, the palette):
 * the surface's own controls on the left, the send cluster pinned right, all
 * on one centre line.
 */
export function ComposerFoot({ start, end }: { start?: ReactNode; end: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 min-h-[36px] pt-0.5 pb-1.5">
      <div className="flex flex-1 min-w-0 items-center gap-1.5">{start}</div>
      <div className="shrink-0 flex items-center gap-1">{end}</div>
    </div>
  );
}

/**
 * The autosizing composer textarea. `dim` greys the text while a rewrite
 * still holds the original message unedited.
 */
export const ComposerTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { dim?: boolean }>(
  function ComposerTextarea({ dim = false, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        {...props}
        rows={1}
        style={FIELD_SIZING_STYLE}
        className={`block w-full [grid-area:1/1] bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-y-auto max-h-[var(--composer-max-h,45vh)] leading-relaxed py-1 ${dim ? "text-sol-text-dim italic" : "text-sol-text"}`}
      />
    );
  },
);

/**
 * Send. Tinted cyan when the send is carried entirely by attached quotes, to
 * match their tray; the bare box uses a small square button.
 */
export function ComposerSendButton({
  canSubmit,
  bare = false,
  quotesOnly = false,
}: {
  canSubmit: boolean;
  bare?: boolean;
  quotesOnly?: boolean;
}) {
  const className = bare
    ? `w-6 h-6 rounded-md transition-colors flex items-center justify-center ${
        !canSubmit ? "text-sol-text-dim/30 cursor-not-allowed" : "text-sol-cyan hover:bg-sol-cyan/10"
      }`
    : `w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${
        !canSubmit
          ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
          : quotesOnly
            ? "border-sol-cyan/50 bg-sol-cyan/20 text-sol-cyan hover:bg-sol-cyan/30 hover:border-sol-cyan"
            : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue hover:text-sol-blue"
      }`;
  return (
    <button
      type="submit"
      disabled={!canSubmit}
      className={className}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
