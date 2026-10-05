// The lane's one composer: home's "What can I take off your plate?" and the
// reply box at the foot of a conversation. Enter sends, Shift+Enter breaks
// the line, and the box grows with what is typed.
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";

export function Composer({
  placeholder,
  onSend,
  hero = false,
  autoFocus = false,
  seed,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  hero?: boolean;
  autoFocus?: boolean;
  /** Text to place in the box (an idea chip), applied when it changes. */
  seed?: { text: string; at: number } | null;
}) {
  const [text, setText] = useState("");
  const [seededAt, setSeededAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  if (seed && seed.at !== seededAt) {
    setSeededAt(seed.at);
    setText(seed.text);
    queueMicrotask(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
      fit(el);
    });
  }

  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 224)}px`;
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      className={`sl-composer${hero ? " is-hero" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          fit(e.target);
        }}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="sl-send" disabled={!text.trim()} aria-label="Send">
        <ArrowUp size={19} strokeWidth={2.4} />
      </button>
    </form>
  );
}
