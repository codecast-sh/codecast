"use client";

import { forwardRef, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { RefTag } from "./kit";

/**
 * The staging checkout the hero's agent drives. One component renders the
 * live page in the Chrome mock and the screenshot thumbnail in the thread, so
 * the picture in the conversation is the same page, at the same moment.
 *
 * `phase`: 0 loading, 1 loaded, 2 refs pinned, 3 card filled, 4 order
 * submitted (spinner), 5 failed (error banner).
 */
export type CheckoutPhase = 0 | 1 | 2 | 3 | 4 | 5;

export const CARD = "4242 4242 4242 4242";

type Props = { phase: CheckoutPhase; typed?: number; refs?: boolean; thumb?: boolean; /** Ref number to outline, as a hovered snapshot row does. */ highlight?: number | null; annotate?: boolean; /** Lay out as a phone would: one column, no order summary. */ narrow?: boolean };

export const CheckoutPage = forwardRef<HTMLDivElement, Props & { cardRef?: React.Ref<HTMLDivElement>; buttonRef?: React.Ref<HTMLDivElement> }>(
  function CheckoutPage({ phase, typed = CARD.length, refs = true, thumb = false, highlight = null, annotate = false, narrow = false, cardRef, buttonRef }, ref) {
    const showRefs = refs && phase >= 2 && phase < 5;
    const card = phase >= 3 ? CARD.slice(0, phase === 3 ? typed : CARD.length) : "";
    const loading = phase === 0;
    return (
      <div ref={ref} className="relative h-full w-full overflow-hidden font-sans" style={{ backgroundColor: "#ffffff", color: "#1d2733" }}>
        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-3 w-24 rounded bg-[#eef0f2]" />
            <div className="h-24 rounded-lg bg-[#f4f5f7]" />
            <div className="h-3 w-40 rounded bg-[#eef0f2]" />
          </div>
        ) : (
          <>
            {/* Site header: signed in, because this is the human's own Chrome. */}
            <div className="flex items-center gap-2 px-4 sm:px-5 h-11 border-b border-[#eceef1]">
              <span className="font-bold tracking-tight text-[15px]">acme</span>
              <span className="rounded px-1.5 py-[1px] text-[9.5px] font-semibold" style={{ backgroundColor: "#fff3c4", color: "#8a6100" }}>staging</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[#5b6875]">
                <span className={narrow ? "hidden" : "hidden sm:inline"}>dana@acme.dev</span>
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ backgroundColor: SOL.violet }}>D</span>
              </span>
            </div>
            <div className={`grid gap-5 px-4 py-4 ${narrow ? "" : "sm:grid-cols-[1fr_1.15fr] sm:px-5"}`}>
              <div className={narrow ? "hidden" : thumb ? "" : "hidden sm:block"}>
                <div className="text-[13px] font-semibold mb-2.5">Your order</div>
                <OrderLine name="Trail runner, size 42" price="$128.00" swatch="#2f6f8f" />
                <OrderLine name="Wool socks, 2 pairs" price="$18.00" swatch="#c56b3c" />
                <div className="mt-3 pt-2.5 border-t border-[#eceef1] flex text-[12px]">
                  <span className="text-[#5b6875]">Total</span>
                  <span className="ml-auto font-semibold">$146.00</span>
                </div>
              </div>
              <div className="relative space-y-2.5">
                {phase === 5 && (
                  <div className="bx-pop rounded-md px-3 py-2 text-[11.5px] leading-snug" style={{ backgroundColor: "#fdecea", color: "#a1261d", border: "1px solid #f5c2bd" }}>
                    <span className="font-semibold">We couldn&apos;t place your order.</span> Please try again.
                  </div>
                )}
                <Field label="Email" refN={3} annotate={annotate} showRef={showRefs} hl={highlight === 3}>
                  <span>dana@acme.dev</span>
                </Field>
                <Field label="Card number" refN={4} annotate={annotate} showRef={showRefs} hl={highlight === 4} focus={phase === 3} innerRef={cardRef}>
                  {card ? <span className={phase === 3 && !thumb ? "bx-caret" : ""}>{card}</span> : <span className="text-[#a3adb8]">1234 1234 1234 1234</span>}
                </Field>
                <Field label="Shipping" refN={5} annotate={annotate} showRef={showRefs} hl={highlight === 5} select>
                  <span>Standard, 3 to 5 days</span>
                </Field>
                <div className="relative flex items-center gap-2 text-[11.5px] text-[#3b4652] pt-0.5 rounded" style={highlight === 6 ? HL : undefined}>
                  <span className="h-3.5 w-3.5 rounded-[3px] border border-[#b8c0c9]" />
                  Save this card
                  <RefTag n={6} annotate={annotate} on={showRefs} style={{ right: 4, top: -2 }} />
                </div>
                <div ref={buttonRef} className="relative">
                  <div
                    className="flex h-9 items-center justify-center gap-2 rounded-md text-[12.5px] font-semibold text-white"
                    style={{ backgroundColor: phase === 4 ? "#4a5867" : "#1d2733", ...(highlight === 7 ? HL : {}) }}
                  >
                    {phase === 4 && <span className="bx-spin h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white" />}
                    {phase === 4 ? "Placing order" : "Place order"}
                  </div>
                  <RefTag n={7} annotate={annotate} on={showRefs} style={{ right: -6, top: -9 }} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  },
);

function OrderLine({ name, price, swatch }: { name: string; price: string; swatch: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-[12px]">
      <span className="h-8 w-8 shrink-0 rounded-md" style={{ background: `linear-gradient(135deg, ${swatch}, ${swatch}99)` }} />
      <span className="min-w-0 truncate">{name}</span>
      <span className="ml-auto shrink-0 text-[#3b4652]">{price}</span>
    </div>
  );
}

const HL: React.CSSProperties = { outline: "2px solid #268bd2", outlineOffset: 2 };

function Field({ label, refN, showRef, children, focus = false, select = false, innerRef, hl = false, annotate = false }: {
  hl?: boolean;
  annotate?: boolean;
  label: string;
  refN: number;
  showRef: boolean;
  children: ReactNode;
  focus?: boolean;
  select?: boolean;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className="relative">
      <div className="text-[10.5px] font-medium text-[#5b6875] mb-1">{label}</div>
      <div
        ref={innerRef}
        className="flex h-8 items-center rounded-md px-2.5 text-[12px] font-mono tabular-nums"
        style={{
          border: `1px solid ${focus ? "#268bd2" : "#d5dbe1"}`,
          boxShadow: focus ? "0 0 0 3px rgba(38,139,210,.15)" : "none",
          ...(hl ? HL : {}),
        }}
      >
        <span className="min-w-0 flex-1 truncate font-sans">{children}</span>
        {select && <svg className="h-3 w-3 text-[#7a8794]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M6 9l6 6 6-6" /></svg>}
      </div>
      <RefTag n={refN} annotate={annotate} on={showRef} style={{ right: 4, top: 6 }} />
    </div>
  );
}
