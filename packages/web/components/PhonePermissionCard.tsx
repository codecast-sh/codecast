import type { CSSProperties } from "react";
import { PERMISSION_CARD_COPY, PERMISSION_CARD_STYLE } from "@codecast/shared/render/permissionCardStyle";
import type { PermissionViewItem } from "./PermissionCard";

type StyleKey = keyof typeof PERMISSION_CARD_STYLE;

// React Native lays every View out as a flex column and every Text as a block;
// the web copy starts from the same defaults so the shared spec lands the same.
// Text drops the spec's RN font face: the card sits in a font-mono root, as the
// app's Themed Text sets JetBrains Mono everywhere.
function view(...keys: Array<StyleKey | false>): CSSProperties {
  const out: CSSProperties = { display: "flex", flexDirection: "column", boxSizing: "border-box" };
  for (const k of keys) if (k) Object.assign(out, PERMISSION_CARD_STYLE[k]);
  return out;
}

function text(key: StyleKey): CSSProperties {
  const { fontFamily: _face, ...rest } = PERMISSION_CARD_STYLE[key] as CSSProperties;
  return { display: "block", ...rest };
}

/**
 * The mobile app's permission card (packages/mobile/components/PermissionCard.tsx)
 * rendered with DOM elements from the same style spec and copy. Pure: the
 * caller owns what Approve and Deny do and whether a response is in flight.
 */
export function PhonePermissionCard({
  permission,
  processing = false,
  onApprove,
  onDeny,
}: {
  permission: PermissionViewItem;
  processing?: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  if (permission.status !== "pending") return null;
  const label = (word: string) => (processing ? PERMISSION_CARD_COPY.processing : word);

  return (
    <div className="font-mono" style={view("container")}>
      <div style={view("content")}>
        <div style={view("header")}>
          <div style={view("indicator")} />
          <span style={text("title")}>{PERMISSION_CARD_COPY.title}</span>
        </div>

        <span style={text("toolName")}>{permission.tool_name}</span>

        {permission.arguments_preview && (
          <div style={view("argsContainer")}>
            <span
              style={{
                ...text("argsText"),
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: PERMISSION_CARD_COPY.argsMaxLines,
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {permission.arguments_preview}
            </span>
          </div>
        )}
      </div>

      <div style={view("buttonContainer")}>
        <button
          type="button"
          style={{ ...view("button", "approveButton", processing && "buttonDisabled"), border: 0, cursor: "pointer" }}
          onClick={onApprove}
          disabled={processing}
        >
          <span style={text("approveButtonText")}>{label(PERMISSION_CARD_COPY.approve)}</span>
        </button>

        <button
          type="button"
          style={{ ...view("button", "denyButton", processing && "buttonDisabled"), border: 0, cursor: "pointer" }}
          onClick={onDeny}
          disabled={processing}
        >
          <span style={text("denyButtonText")}>{label(PERMISSION_CARD_COPY.deny)}</span>
        </button>
      </div>
    </div>
  );
}
