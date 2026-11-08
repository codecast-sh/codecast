"use client";
// The browser pane's address bar.
//
// At rest it reads as a label, not a form: the page's mark, the host at full
// strength and the path dimmed, on the header's own ground. Reaching for it
// (hover, Cmd/Ctrl+L, a click) raises a field around the same text, and
// focusing swaps in the whole URL, selected, so typing replaces it.
//
// Typing offers the pages this browser opened in a pane before
// (lib/browserPaneRecents): the best match completes the field inline, its
// tail selected so the next key overwrites it, and the rest sit in a list
// under the bar. Enter goes where the field says; the pane decides whether
// that is a new page or a reload of this one.

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Globe, Lock } from "lucide-react";
import { addressParts, pageAddress } from "../../lib/browserPane";
import { browserPaneRecents, inlineCompletion, suggestAddresses, type AddressSuggestion } from "../../lib/browserPaneRecents";
import { useSqueezeToFit } from "../../hooks/useSqueezeToFit";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { KeyCap, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import "./addressBar.css";

export function AddressField({
  url,
  inputRef,
  rowRef,
  onNavigate,
}: {
  /** The page on screen, or "" for a blank pane. */
  url: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The header row, measured so the badge folds before the address does. */
  rowRef: RefObject<HTMLElement | null>;
  /** Go to what was entered. False when it is not a web address. */
  onNavigate: (raw: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  // What the person typed, apart from what the bar filled in after it. Null
  // until they type: the field then shows the page's own URL.
  const [typed, setTyped] = useState<string | null>(null);
  const [completion, setCompletion] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [recents, setRecents] = useState<string[]>([]);
  const [rejected, setRejected] = useState(0);
  // Several panes can be open at once, so the list's ids are per field.
  const listId = useId();

  // A new page is a new address: anything typed toward the old one goes.
  useWatchEffect(() => {
    setTyped(null);
    setCompletion("");
    setHighlight(-1);
  }, [url]);

  const suggestions = useMemo(
    () => (typed ? suggestAddresses(typed, recents.filter((r) => r !== url)) : []),
    [typed, recents, url],
  );
  const picked: AddressSuggestion | undefined = suggestions[highlight];
  // The mark says where Enter goes: the page on screen until someone types,
  // then the page the field now names, or nothing yet.
  const target = typed === null && !picked ? url : (picked ?? (completion ? suggestions[0] : undefined))?.url ?? "";
  const value = picked ? picked.label : typed !== null ? typed + completion : editing ? url : pageAddress(url);

  // Selection is set after the render that put the text there: replacing an
  // input's value drops its selection. On focus that is the whole URL; while
  // completing, only the filled-in tail.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !editing) return;
    if (typed === null && !picked) el.select();
    else if (completion && !picked) el.setSelectionRange(typed!.length, value.length);
  }, [editing, typed, completion, picked, value, inputRef]);

  useSqueezeToFit(rowRef, 1, value);

  const reset = useCallback(() => {
    setTyped(null);
    setCompletion("");
    setHighlight(-1);
  }, []);

  const submit = useCallback(() => {
    const target = picked?.url ?? suggestions.find((s) => s.label.toLowerCase() === value.toLowerCase())?.url ?? value;
    if (!onNavigate(target)) {
      setRejected((n) => n + 1);
      return;
    }
    reset();
    inputRef.current?.blur();
  }, [picked, suggestions, value, onNavigate, reset, inputRef]);

  // The row Enter would take: the one arrowed to, else the one completing the
  // field inline.
  const activeRow = highlight >= 0 ? highlight : completion ? 0 : -1;
  const listOpen = editing && suggestions.length > 0;

  return (
    <div
      className="ab-field"
      data-editing={editing || undefined}
      data-rejected={rejected ? (rejected % 2 ? "odd" : "even") : undefined}
      onMouseDown={(e) => {
        // The whole pill is the target, not only the text inside it.
        if (e.target !== inputRef.current) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <SiteMark url={target} />
      <div className="ab-text">
        <input
          ref={inputRef}
          value={value}
          title={editing ? undefined : url || undefined}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="Type an address"
          aria-label="Address"
          role="combobox"
          aria-expanded={listOpen}
          aria-autocomplete="both"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen && activeRow >= 0 ? `${listId}-${activeRow}` : undefined}
          // The floor is the whole address (1ch per character in a mono face),
          // so an address that does not fit overflows the row and the squeeze
          // folds the badge. At level 1 it drops back to 88px: the address
          // ellipsizes, but never vanishes.
          style={{ minWidth: `max(88px, ${value.length + 1}ch)` }}
          className="ab-input"
          onChange={(e) => {
            const next = e.target.value;
            const deleting = (e.nativeEvent as InputEvent).inputType?.startsWith("delete");
            setRejected(0);
            setHighlight(-1);
            setTyped(next);
            // Completing while someone deletes would put back what they just
            // took away; only a key that adds text earns a completion.
            setCompletion(deleting ? "" : inlineCompletion(next, suggestAddresses(next, recents.filter((r) => r !== url))[0]));
          }}
          onFocus={() => {
            setEditing(true);
            // Read per focus: a page opened in another pane since counts.
            setRecents(browserPaneRecents());
          }}
          onBlur={() => {
            setEditing(false);
            setRejected(0);
            reset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // First Esc puts the page's address back, second leaves.
              if (typed !== null || picked) {
                reset();
                setRejected(0);
              } else inputRef.current?.blur();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (!suggestions.length) return;
              e.preventDefault();
              // Steps from the row Enter would take now, so the first Down
              // moves past the completed row rather than onto it again.
              const n = suggestions.length;
              setHighlight(e.key === "ArrowDown" ? (activeRow + 1 >= n ? -1 : activeRow + 1) : activeRow <= 0 ? (activeRow === 0 ? -1 : n - 1) : activeRow - 1);
            } else if (completion && !picked && (e.key === "Backspace" || e.key === "Delete")) {
              // The filled-in tail goes first, the way every browser does it.
              e.preventDefault();
              setCompletion("");
            } else if (completion && !picked && (e.key === "Tab" || e.key === "ArrowRight" || e.key === "End")) {
              if (e.key === "Tab") e.preventDefault();
              setTyped(typed! + completion);
              setCompletion("");
            }
          }}
        />
        {!editing && url && <AddressText url={url} />}
        {rejected > 0 && (
          <span key={rejected} className="ab-reject" aria-live="polite">
            not an address
          </span>
        )}
      </div>
      {listOpen && (
        <div id={listId} role="listbox" className="ab-list">
          {suggestions.map((s, i) => (
            <div
              key={s.url}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeRow}
              className="ab-row"
              data-on={i === activeRow || undefined}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                if (onNavigate(s.url)) {
                  reset();
                  inputRef.current?.blur();
                }
              }}
            >
              <SiteMark url={s.url} quiet />
              <AddressText url={s.url} as="row" />
              {i === activeRow && <KeyCap size="xs">↵</KeyCap>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Host at full strength, the rest of the address dimmed. */
function AddressText({ url, as = "field" }: { url: string; as?: "field" | "row" }) {
  const { host, rest } = addressParts(url);
  return (
    <span className={as === "field" ? "ab-shown" : "ab-row-text"} aria-hidden={as === "field" || undefined}>
      <span className="ab-host">{host}</span>
      {rest && <span className="ab-rest">{rest}</span>}
    </span>
  );
}

/**
 * The page's own mark once its favicon loads, else what the glyph can say
 * honestly: a lock for https, a globe otherwise. A favicon that fails (none
 * served, an http icon under an https app) leaves the glyph in place.
 */
function SiteMark({ url, quiet }: { url: string; quiet?: boolean }) {
  const icon = useMemo(() => faviconUrl(url), [url]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const secure = url.startsWith("https://");
  const glyph: ReactNode = secure ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />;
  const mark = (
    <span className="ab-mark" data-loaded={(!!icon && loaded === icon) || undefined}>
      <span className="ab-glyph">{glyph}</span>
      {icon && (
        <img
          key={icon}
          src={icon}
          alt=""
          className="ab-favicon"
          referrerPolicy="no-referrer"
          onLoad={(e) => {
            // Some servers answer /favicon.ico with a 1x1 or an HTML page that
            // still "loads"; neither is a mark.
            if (e.currentTarget.naturalWidth >= 8) setLoaded(icon);
          }}
        />
      )}
    </span>
  );
  if (quiet || !url) return mark;
  return <ShortcutTooltip label={secure ? "Served over https" : "Served over http"}>{mark}</ShortcutTooltip>;
}

function faviconUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // An http icon under an https app is blocked as mixed content anyway;
    // asking only adds a console warning.
    if (u.protocol === "http:" && typeof window !== "undefined" && window.location.protocol === "https:") return null;
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}
