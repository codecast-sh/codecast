import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, Cpu, Ellipsis, List } from "lucide-react";
import {
  MOBILE_AGENT_LABEL,
  MOBILE_AGENT_LOGO_BG,
  MOBILE_AGENT_TINT,
  MOBILE_CHIP_STYLE,
  MOBILE_COMPOSER_STATUS,
  MOBILE_SESSION_HEADER_HEIGHT,
  MOBILE_SESSION_STYLE as S,
} from "@codecast/shared/render/mobileSessionStyle";
import { formatToolName, toolIcon, toolResultHint, toolSummary, type ToolCallLike, type ToolColorToken } from "@codecast/shared/render";
import { ClaudeIcon, CursorIcon, GeminiIcon, GrokIcon, OpenAIIcon } from "./BrandIcons";
import { formatModel } from "../lib/conversationProcessor";
import { FaArrowUp, FaChevronLeft, FaCodeFork, FaLevelUp, FaPlus, FaServer, IonHeadsetOutline } from "./PhoneGlyphs";

/**
 * The mobile app's session screen (packages/mobile/app/session/[id].tsx)
 * drawn with DOM elements from the screen's own spec
 * (@codecast/shared/render/mobileSessionStyle), for the marketing hero's
 * phone, in the app's default light theme. Colours are the theme's tokens;
 * RN's column flex is spelled out where it lays out.
 * A hairline is half a pixel.
 */

const HAIRLINE = 0.5;
/** RN's `borderLight` in the app's light palette (constants/Theme.ts), which the web tokens have no name for. */
const BORDER_LIGHT = "#c5c8c6";
const tint = (color: string, alpha: number) => `color-mix(in srgb, ${color} ${alpha}%, transparent)`;
const col: CSSProperties = { display: "flex", flexDirection: "column" };
/** A spec style as DOM style: RN reads a numeric lineHeight as px, the DOM as a multiple of the font size. */
const css = (s: object): CSSProperties => {
  const { lineHeight, ...rest } = s as CSSProperties;
  return typeof lineHeight === "number" ? { ...rest, lineHeight: `${lineHeight}px` } : (rest as CSSProperties);
};

const MARK: Record<string, (p: { className?: string }) => ReactNode> = { codex: OpenAIIcon, claude_code: ClaudeIcon, cursor: CursorIcon, gemini: GeminiIcon, grok: GrokIcon };

/** The agent's tile and mark, as AgentLogoSvg draws it: the mark at 60% of the tile. */
function PhoneAgentLogo({ agentType }: { agentType: string }) {
  const Mark = MARK[agentType];
  return (
    <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center text-white" style={{ borderRadius: 3, background: MOBILE_AGENT_LOGO_BG[agentType] ?? "#cb4b16" }}>
      {Mark && <Mark className="h-[7.8px] w-[7.8px]" />}
    </span>
  );
}

const agentTint = (agentType: string) => MOBILE_AGENT_TINT[agentType] ?? "var(--sol-yellow)";

/**
 * The pinned title bar: back, the session's title, then the huddle button
 * (when the team has calls), the message list (once the session has
 * messages), and more. `top` is the status bar's inset, which the bar's
 * colour runs under.
 */
export function PhoneSessionHeader({ title, top = 0, huddle, messageList }: { title: string; top?: number; huddle?: boolean; messageList?: boolean }) {
  const btn = css({ ...S.headerIconBtn, display: "flex" });
  return (
    <div className="shrink-0 bg-sol-bg-alt" style={css({ ...S.pinnedHeader, display: "flex", paddingTop: top, height: top + MOBILE_SESSION_HEADER_HEIGHT, boxSizing: "border-box" })}>
      <span className="text-sol-text" style={btn}>
        <FaChevronLeft size={18} />
      </span>
      <span className="truncate font-semibold text-sol-text" style={css({ ...S.headerTitleText, minWidth: 0 })}>{title}</span>
      {huddle && (
        <span className="text-sol-text-muted" style={{ display: "flex", alignItems: "center", padding: "4px 6px" }}>
          <IonHeadsetOutline size={17} />
        </span>
      )}
      {messageList && (
        <span className="text-sol-text-muted" style={btn}>
          <List size={17} strokeWidth={2} />
        </span>
      )}
      <span className="text-sol-text-muted" style={btn}>
        <Ellipsis size={18} />
      </span>
    </div>
  );
}

function Chip({ color, icon, trailing, children }: { color: string; icon: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <span className="shrink-0" style={css({ ...MOBILE_CHIP_STYLE.shell, display: "flex", borderWidth: HAIRLINE, borderStyle: "solid", borderColor: tint(color, 25), background: tint(color, 8), boxSizing: "border-box" })}>
      {icon}
      <span className="truncate" style={css({ ...MOBILE_CHIP_STYLE.text, color })}>{children}</span>
      {trailing && <span style={{ display: "flex", color }}>{trailing}</span>}
    </span>
  );
}

/** The machine a session runs on and who owns it, as the app's AssignmentChip draws them: two lobes in one shell, their tints meeting edge to edge. */
function AssignmentChip({ device, owner }: { device: { name: string; remote: boolean; online: boolean }; owner: string }) {
  // The app's deviceColor: a cloud host violet, a Linux box orange, a Mac cyan.
  const color = device.remote ? "var(--sol-violet)" : "var(--sol-cyan)";
  const lobe: CSSProperties = { display: "flex", alignItems: "center", gap: 4, paddingLeft: 7, paddingRight: 7 };
  const initials = owner.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="shrink-0" style={{ display: "flex", alignItems: "stretch", height: MOBILE_CHIP_STYLE.shell.height, borderWidth: HAIRLINE, borderStyle: "solid", borderColor: "var(--sol-border)", borderRadius: 6, overflow: "hidden", maxWidth: 210, boxSizing: "border-box" }}>
      <span style={{ ...lobe, background: tint(color, 8) }}>
        <FaServer size={10} color={color} />
        <span className="truncate" style={css({ ...MOBILE_CHIP_STYLE.text, color })}>{device.name}</span>
        <span style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: device.online ? "var(--sol-green)" : "var(--sol-text-muted0)" }} />
      </span>
      <span style={{ ...lobe, background: tint("var(--sol-cyan)", 8) }}>
        <span className="text-sol-text-muted" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: 7, flexShrink: 0, background: "var(--sol-bg-alt)", border: `${HAIRLINE}px solid var(--sol-border)`, fontSize: 14 * 0.42, fontWeight: 600, boxSizing: "border-box" }}>{initials}</span>
        <span className="truncate" style={css({ ...MOBILE_CHIP_STYLE.text, color: "var(--sol-cyan)" })}>{owner}</span>
      </span>
    </span>
  );
}

/**
 * The strip under the title bar, in the app's order: the agent, when it last
 * moved, the live dot, the model (with its switcher's chevron on your own
 * session), the branch, where it runs and who owns it, and the parent it was
 * spawned by. The app's strip scrolls sideways, so what runs past the edge
 * is clipped there.
 */
export function PhoneSessionMeta({ agentType, ago, live, model, modelEditable, branch, assignment, parent, dot }: {
  agentType: string;
  ago: string;
  live: boolean;
  model?: string;
  modelEditable?: boolean;
  branch?: string;
  assignment?: { device: { name: string; remote: boolean; online: boolean }; owner: string };
  parent?: boolean;
  dot?: ReactNode;
}) {
  return (
    <div className="shrink-0 bg-sol-bg-alt" style={css({ ...S.floatingSessionCard, borderBottom: `${HAIRLINE}px solid ${BORDER_LIGHT}` })}>
      {/* The app's strip is a horizontal scroller: nothing in it wraps or squeezes, and what runs past the edge is clipped. */}
      <div className="overflow-hidden whitespace-nowrap" style={css({ ...S.sessionMeta, display: "flex" })}>
        <span className="shrink-0" style={css({ ...S.metaBadgeIcon, display: "flex" })}>
          <PhoneAgentLogo agentType={agentType} />
          <span style={css({ ...MOBILE_CHIP_STYLE.text, color: agentTint(agentType) })}>{MOBILE_AGENT_LABEL[agentType] ?? agentType}</span>
        </span>
        <span className="shrink-0 text-sol-text-muted" style={css(S.messageCountText)}>· {ago}</span>
        {live && (dot ?? <PhoneStatusDot color="#10b981" glow />)}
        {model && (
          <Chip color="var(--sol-cyan)" icon={<Cpu size={10} />} trailing={modelEditable && <ChevronDown size={9} style={{ opacity: 0.7, flexShrink: 0 }} />}>
            {formatModel(model)}
          </Chip>
        )}
        {branch && <Chip color="var(--sol-green)" icon={<FaCodeFork size={10} />}>{branch}</Chip>}
        {assignment && <AssignmentChip {...assignment} />}
        {parent && <Chip color="var(--sol-violet)" icon={<FaLevelUp size={10} />}>Parent</Chip>}
      </div>
    </div>
  );
}

/** A status dot; `opacity` is the pulse's phase, which the caller drives. The strip's live dot glows (the app's activeDot shadow). */
export function PhoneStatusDot({ color, opacity = 1, glow }: { color: string; opacity?: number; glow?: boolean }) {
  return <span className="shrink-0" style={css({ ...S.dot, display: "block", background: color, opacity, boxShadow: glow ? `0 0 4px color-mix(in srgb, ${color} 80%, transparent)` : undefined })} />;
}

/** One message as the screen's MessageBubble draws it: the header (avatar or agent dot, role, model, time) when it opens a turn, then its body. */
export function PhoneMessage({ role, name, agentType, model, time, showHeader = true, children }: {
  role: "user" | "assistant";
  /** The user's name; the assistant is named for its agent. */
  name?: string;
  agentType: string;
  model?: string;
  time: string;
  showHeader?: boolean;
  children: ReactNode;
}) {
  const user = role === "user";
  const label = user ? name || "You" : MOBILE_AGENT_LABEL[agentType] ?? "Claude";
  return (
    <div
      style={css({
        ...col,
        ...S.messageBubble,
        ...(user ? { ...S.userBubble, borderStyle: "solid", borderColor: tint("var(--sol-blue)", 40), background: tint("var(--sol-blue)", 15) } : S.assistantBubble),
        ...(showHeader && !user ? S.assistantBubbleFirst : null),
      })}
    >
      {showHeader && (
        <div style={css({ ...S.bubbleHeader, display: "flex" })}>
          {user ? (
            <span style={css({ ...S.userAvatar, display: "flex", background: tint("var(--sol-blue)", 25) })}>
              <span className="text-sol-blue" style={css(S.userAvatarText)}>{label[0].toUpperCase()}</span>
            </span>
          ) : (
            <span style={css({ ...S.agentDot, display: "block", background: agentTint(agentType) })} />
          )}
          <span className={user ? "text-sol-blue" : undefined} style={css({ ...S.bubbleRole, color: user ? undefined : "var(--sol-text-muted0)" })}>{label}</span>
          {!user && model && <span className="text-sol-text-dim" style={css(S.modelBadge)}>{formatModel(model)}</span>}
          <span className="text-sol-text-dim" style={css(S.bubbleTime)}>{time}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** A message's text, at the screen's body size. */
export function PhoneMessageText({ children }: { children: ReactNode }) {
  return (
    <div style={css(S.bubbleContent)}>
      <p className="m-0 text-sol-text" style={css(S.bubbleText)}>{children}</p>
    </div>
  );
}

/** The concrete colour of each tool tint, as the app's toolColorHex resolves it. */
const TOOL_COLOR: Record<ToolColorToken, string> = {
  green: "var(--sol-green)",
  blue: "var(--sol-blue)",
  violet: "var(--sol-violet)",
  orange: "var(--sol-orange)",
  cyan: "var(--sol-cyan)",
  magenta: "var(--sol-magenta)",
  red: "var(--sol-red)",
  textDim: "var(--sol-text-dim)",
  emerald: "#10b981",
  amber: "#f59e0b",
};

/**
 * A message's tool calls, one collapsed line each as the screen's
 * ToolCallItem draws them: the tool's name in its colour, what it ran, and
 * how it came out. A message of tool calls alone is the compact bubble.
 */
export function PhoneToolCalls({ calls, only }: { calls: { call: ToolCallLike; result?: { content: string; is_error?: boolean } }[]; only?: boolean }) {
  const list = (
    <div style={css({ ...col, ...(only ? S.toolCallsCompact : S.toolCallsContainer) })}>
      {calls.map(({ call, result }, i) => {
        const summary = toolSummary(call);
        const hint = toolResultHint(call, result);
        return (
          <p key={i} className="m-0 truncate" style={css(S.toolCallHeader)}>
            <span style={css({ ...S.toolCallName, color: TOOL_COLOR[toolIcon(call.name).color] })}>{formatToolName(call.name)}</span>
            {summary && <span className="text-sol-text-muted" style={css(S.toolCallSummary)}> {summary}</span>}
            {hint && <span className="text-sol-text-dim" style={css(S.toolCallResultHint)}> {hint}</span>}
          </p>
        );
      })}
    </div>
  );
  return only ? <div style={css({ ...col, ...S.messageBubble, ...S.assistantBubble, ...S.toolCallOnlyBubble })}>{list}</div> : list;
}

/**
 * The composer: the input card over its button row (attach, the agent's
 * status, send). `value` is what is typed; the placeholder shows when it is
 * empty, and `caret` marks a focused field. `bottom` is the home indicator's
 * inset under it.
 */
export function PhoneComposer({ value, placeholder, status, statusDot, statusWrap, caret, bottom, send }: {
  value: string;
  placeholder: string;
  status?: string;
  /** The status's pulsing dot, drawn by the caller (its phase is the caller's clock). */
  statusDot?: ReactNode;
  /** Wraps the status, for a fade the caller drives. */
  statusWrap?: (status: ReactNode) => ReactNode;
  caret?: boolean;
  bottom: number;
  /** Wraps the send button, for a press the caller animates. */
  send?: (button: ReactNode) => ReactNode;
}) {
  const meta = status ? MOBILE_COMPOSER_STATUS[status] : undefined;
  const canSend = value.length > 0;
  const button = (
    <span className={`text-white ${canSend ? "bg-sol-blue" : "bg-sol-bg-highlight"}`} style={css({ ...S.sendButton, display: "flex", boxSizing: "border-box" })}>
      <FaArrowUp size={14} />
    </span>
  );
  return (
    <div className="shrink-0 bg-sol-bg-alt" style={{ borderTop: `${HAIRLINE}px solid ${BORDER_LIGHT}`, paddingBottom: bottom }}>
      <div className="bg-sol-bg" style={css({ ...col, ...S.composerCard, border: `${HAIRLINE}px solid ${BORDER_LIGHT}` })}>
        <div style={css({ ...S.textInput, lineHeight: "20px", boxSizing: "border-box" })}>
          {value ? <span className="text-sol-text">{value}</span> : null}
          {caret && <span className="inline-block bg-sol-blue align-middle" style={{ width: 2, height: 19, marginTop: -2, borderRadius: 1 }} />}
          {!value && <span style={{ color: "var(--sol-text-muted0)", marginLeft: caret ? -2 : 0 }}>{placeholder}</span>}
        </div>
        <div style={css({ ...S.composerActions, display: "flex" })}>
          <span className="text-sol-text-muted" style={css({ ...S.imageButton, display: "flex" })}>
            <FaPlus size={18} />
          </span>
          <span style={css({ ...S.composerSpacer, display: "flex" })}>
            {meta &&
              (statusWrap ?? ((n: ReactNode) => n))(
                <span style={css({ ...S.composerStatus, display: "flex" })}>
                  {statusDot ?? <PhoneStatusDot color={meta.color} />}
                  <span style={css({ ...MOBILE_CHIP_STYLE.text, color: meta.color })}>{meta.label}</span>
                </span>,
              )}
          </span>
          {send ? send(button) : button}
        </div>
      </div>
    </div>
  );
}
