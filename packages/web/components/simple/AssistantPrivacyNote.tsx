// The assistant's privacy line with its link, set the same way on each door
// (#everyone, /welcome's sign in, the pricing door). The words are
// assistantPromise.ts assistantPrivacy; each door gives its own type styles.
import type { CSSProperties } from "react";
import { assistantPrivacy } from "./assistantPromise";

export function AssistantPrivacyNote({ mail, className, style }: { mail: boolean; className?: string; style?: CSSProperties }) {
  return (
    <p data-cc-assistant-privacy className={className} style={style}>
      {assistantPrivacy(mail)}{" "}
      <a href="/privacy" className="underline underline-offset-2 hover:no-underline">Privacy</a>
    </p>
  );
}
