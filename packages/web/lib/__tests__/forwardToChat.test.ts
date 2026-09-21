import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { openForwardToChat } from "../forwardToChat";
import type { PalettePick } from "../palettePick";

// Real Convex ids are 32 chars — the store branches on that everywhere to tell
// a server row from a local stub.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const CHANNEL = serverId("chan1");
const ME = serverId("userme");
const THEM = serverId("userthem");
const URL = "https://codecast.sh/conversation/abc";

function currentPick(): PalettePick {
  const pick = useInboxStore.getState().palette.pick;
  if (!pick) throw new Error("palette has no pick");
  return pick;
}

describe("openForwardToChat", () => {
  const owner = {};

  beforeEach(() => {
    useInboxStore.setState({
      chatChannels: {},
      chatMessages: {},
      chatReads: {},
      sessions: {},
      conversations: {},
      messages: {},
      pending: {},
      currentUser: { _id: ME },
      clientState: { ui: {} },
      palette: { open: false, targets: [], targetType: null, initialMode: "root" },
    } as any);
    useInboxStore.getState()._setDispatch(async () => null, { owner });
  });

  it("opens the palette in channel pick mode with an optional message field", () => {
    openForwardToChat({ url: URL, label: "session" });
    const { palette } = useInboxStore.getState();
    expect(palette.open).toBe(true);
    expect(palette.pick?.kinds).toEqual(["channel"]);
    expect(palette.pick?.notePlaceholder).toBeTruthy();
    expect(palette.pick?.title).toContain("session");
  });

  it("sends note + url to a picked channel", () => {
    openForwardToChat({ url: URL });
    currentPick().onPick({ kind: "channel", id: CHANNEL, label: "#general" }, { note: "worth a look", query: "" });
    const rows = Object.values(useInboxStore.getState().chatMessages) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].channel_id).toBe(CHANNEL);
    expect(rows[0].content).toBe(`worth a look\n\n${URL}`);
  });

  it("previews a cached session title before choosing a recipient", () => {
    const id = serverId("session");
    useInboxStore.setState({ sessions: { [id]: { _id: id, title: "Polish the chat send dialog", short_id: "jx7test" } } } as any);
    openForwardToChat({ url: `https://codecast.sh/conversation/${id}`, label: "session" });
    expect(currentPick().preview?.title).toBe("Polish the chat send dialog");
  });

  it("previews the exact linked message instead of another message in the session", () => {
    const id = serverId("session");
    const messageId = serverId("message");
    useInboxStore.setState({
      sessions: { [id]: { _id: id, title: "Chat polish", short_id: "jx7test" } },
      messages: { [id]: [{ _id: serverId("other"), content: "Unrelated message" }, { _id: messageId, content: "Please **review** the [dialog](https://example.com)." }] },
    } as any);
    openForwardToChat({ url: `https://codecast.sh/conversation/jx7test#msg-${messageId}`, label: "message" });
    expect(currentPick().preview?.title).toBe("Chat polish");
    expect(currentPick().preview?.text).toBe("Please review the dialog.");
  });

  it("carries an excerpt for public share links without changing the sent message", () => {
    const url = "https://codecast.sh/share/message/share-token";
    openForwardToChat({ url, label: "messages", previewTitle: "Chat polish", previewText: "First selected message\n\nSecond selected message" });
    expect(currentPick().preview).toEqual({ title: "Chat polish", text: "First selected message Second selected message", url });
    currentPick().onPick({ kind: "channel", id: CHANNEL, label: "#general" }, { query: "" });
    expect(Object.values(useInboxStore.getState().chatMessages)[0].content).toBe(url);
  });

  it("bounds long excerpts and falls back to the link for uncached content", () => {
    openForwardToChat({ url: URL, previewText: "A long message ".repeat(200) });
    expect(currentPick().preview!.text!.length).toBeLessThanOrEqual(240);
    expect(currentPick().preview!.text).toEndWith("…");
    openForwardToChat({ url: URL });
    expect(currentPick().preview).toEqual({ title: "Shared link", text: undefined, url: URL });
  });

  it("sends note + url with attached images", () => {
    openForwardToChat({ url: URL });
    const storage = serverId("img1");
    currentPick().onPick(
      { kind: "channel", id: CHANNEL, label: "#general" },
      { note: "look", query: "", attachments: [{ storage_id: storage, mime: "image/png" }] },
    );
    const rows = Object.values(useInboxStore.getState().chatMessages) as any[];
    expect(rows[0].content).toBe(`look\n\n${URL}`);
    expect(rows[0].attachments).toEqual([{ storage_id: storage, mime: "image/png" }]);
  });

  it("sends just the url when no note was typed", () => {
    openForwardToChat({ url: URL });
    currentPick().onPick({ kind: "channel", id: CHANNEL, label: "#general" }, { note: undefined, query: "" });
    const rows = Object.values(useInboxStore.getState().chatMessages) as any[];
    expect(rows[0].content).toBe(URL);
  });

  it("opens a DM for a person target and sends there", () => {
    openForwardToChat({ url: URL });
    currentPick().onPick({ kind: "person", id: THEM, label: "Sam" }, { note: undefined, query: "" });
    const state = useInboxStore.getState();
    const dm = Object.values(state.chatChannels).find((c: any) => c.kind === "dm") as any;
    expect(dm).toBeTruthy();
    expect(dm.dm_key).toContain(THEM);
    const rows = Object.values(state.chatMessages) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].channel_id).toBe(dm._id);
  });

  it("reuses an existing DM room for a person target", () => {
    const existing = serverId("dmroom");
    useInboxStore.setState({
      chatChannels: {
        [existing]: { _id: existing, kind: "dm", name: "", dm_key: `:${[ME, THEM].sort().join(":")}`, created_at: 1, updated_at: 1 },
      },
    } as any);
    openForwardToChat({ url: URL });
    currentPick().onPick({ kind: "person", id: THEM, label: "Sam" }, { note: undefined, query: "" });
    const rows = Object.values(useInboxStore.getState().chatMessages) as any[];
    expect(rows[0].channel_id).toBe(existing);
  });
});
