import { internalMutation } from "./functions";
import { v } from "convex/values";
import { formatSessionMessage } from "./pendingMessages";

const reviewedTuples = new Set([
  "bb0739536b4c6f2fbc231688320291752154f6069ff2c1784c40e52cd39797c5",
  "79c090a72f03d9f7f838208e48ebfde9af9a58fa1a14d6c8f15981d3325d351a",
  "5c8477a55e695085813dd8044c73e898c8085d19850fa466283c83cb5c044340",
  "3272a3dd443d8fe1776a302a9ce7248b0ef03662ad44a25e9d09da0ad43b59af",
  "06a8cdeaa16f2f34d1d2468957cd8bd29f0b983c7885424635772be36761d14d",
  "8ded960147af9390624d62062b22a27d507a984659b1c40712f7d3a51bba941e",

  "a80914c41c6145bd3423da071e28f14ddfa8a0952f775e99e05461519e050f05",
  "762b698a7a868cfa04271f2c92fbf198a749c7820a48bbc233cc3055288208f6",
  "2d242cb03fb3fc257720b20ab8de2f4eacada1769cbbffd6c08ea647f667aa7b",
  "c55598083cb6d065324886c5158b0dd2f3da2db4b25122aae5498ee4107ae531",
  "eb64ae5098441e46b9aa3e554ff59d00e2b3172d62f0b1c4bfada0a34228f9f4",
  "719c085f126ca4d02172270bc5e05925791d98b64f9b6d769403e1ca47c64caf",
  "f23b012c548e0459f62500e4e68eb8acc6d4e05dbc93079ebe533d1c8915e32b",
  "2d78ff4c9a43b7216d076e1ba9bacc9bd49ae1825e1230a8c176573907fc0658",
  "b967dc7a7b2d249cc7eebd9534dfcb3a502f8d2444626e4ca0bde4ff5ba2965e",
  "eb5d3c86eca78cb50371dff2cf6b93a6917ffeb8af522751534f519a3e826e83",
  "06d0af233880fd187977d97cec6f5ad3706ff3d2dc0615422be7e470eb3d56d8",
  "22af890309ed1b195201c9d56ed22c142271c9aa1af8e68a679d2299115841be",
  "8f5e9252def9b36eb67ac0feafff86238f370bfdc965d16b208c6d1073ad6c89",
  "4a963ce180e14ca775782fee4e40e8be3bef9f29e6e69de82305a8e4242f75e7",
  "7395141aa9f73130606c6b8fb43774c4fa7369fdf6c5307feb50477da5d4293a",
  "744f35d66a2a25179b489b61a531b94641977f169b7119644494a85bc777d0b6",
  "f0da20f20ff960cb615a607d9526ac3b6018b6262bdce94e80ce0db46be11427",
  "358954f48b05ebe984ae642ee40de319534a6d7d6f740fcd1857d50c280e5823",
  "c5e1377322fa46f4b6f13515a21493676da9805b6d416ce21c079e93cb17cd69",
  "5d9ea648c6b4fcb3d1717c6610a54d186cc1da52295701ca52ec9a04b79a484e",
  "ba2ca173af0da59d41a99d0a1d19dadeb507da98de4a7ced4316712e0d157fd8",
  "acc20235b45b0e3edbb6a1f4e33077fd5abd726d8d67f278134490150fd7f16a",
  "b4cd9af8048bad083a6b4952ead6bdc96970cfbe453e225ef89ca4f532c89196",
  "6aa34fefff6b0422b993a900ef5b2cefb279b0f8f0970b66c6fd348435670c3c",
  "5875e0fe432b724314ed5f5e53c4195629d043f819fe8a5c337812539556f676",
  "282080f4609a0ae4c9264f1aeceb6b7a9e9e8d2d2e789127c810184faf97fa24",
  "6d45a8f108be0fc15f0202872432d6154a84af1babb2fdc802ad9c96b79ef88b",
  "800bdf1663c53fd85efcd722c99570192243bf97444e4af23ffdc74c186374d7",
  "83c7c67de0811aebbe8d6ac2969e68ef2a19707be08d450fd48dcef08331b737",
  "25d7d159cc683545a7801fdb9a9a265cd67e1b8355cf43b4817ea79a2c52b155",
  "319d376adb978d970ed4a1ca8965b709a62f998eeb1c59c02de5cf51b75234a5",
  "f65b6737ba4ba7718b96b07d266e1832c57a98b19ea9eb6326dfb21d82965d24",
  "263e24ffc5182a8096a0c433b164894912da75803d424b25b7d1e2cba43e03d7",
  "51b6e7fb82c34933e48e628cf6d57db731fa458c6d3840e9edede87adca84293",
  "c3da97c6e50654617f0dce33a480a7e36ed73d40a959b1af5a9afc892929dc36",
  "a8fcf9ba1e816141ae5e7065081ff32f58f53c6bb92eff386799f2865487c680",
  "b62e80289f1f6c4fb9b8df2c382898379f50da18224cb1f045656c16529fdb83",
  "ea95fd07dbbf27048e4af24a8e47f2fb6d1abfe87f36101a5c6c87f40deb2a94",
  "7eac2e714d8202124f5c31dd3f9d2186982bfaabf12b18a213b69fe8c0ea35d5",
  "8c0df19d01a395822145627f8b35ce61d6f259ccfcd0be2c803dc2d0cad69725",
  "0a07077720d7e832e610e7ea48f800dc4e1e60398c4790448fcb129f24f6dd27",
  "b842d38e336838fb6ca55dea20ff6f8ef484ce760264ac763492babe78fb9d3b",
  "a4367626f6f0609c2f4f72f972316680c767117e7fd58d6e1bbaf0d09a4a1335",
  "48eb3b224ae2beb810d90ef57f72bf4101ba3a40945b4e9db1b387cca83f7d34",
  "e69e8ca0988468ccd19b8e16212eae319d392ac0a02c6621ff1754a6530ba22f",
  "c5de939b73247a62d34c0ea6c7f2e08de57bf351d5b7eca76e4abf700104b9c9",
  "2633334496fbe24a685b470aa13902f0ddfdab931237a1a8c12940dd99e290bd",
  "348d091764a6be0c4f9f96081a19328b20ec6f0e9c50ef521c1fecdc3f236bd7",
  "bfaa7210a27c0cac853a35b927f63e364faece116d688ab4cbef5c721ea7bce4",
  "b0cf3cd5eb3af53fb574d145877335ce0756c1bee1b58a64ad91efb0ff768ead",
  "6c956ce95c3e9b7d61dc06acbb808329e4d53978621ebda063ba390d3cacda12",
  "182b56803a866f759159eedfa4a25cc60220148d97231971244b939e72497862",
  "ae3fed808e51b2692793d52183396eeedfc8777c63f8fd8fb1eb45b8c2d4c9ed",
  "6697ce16d244faaf192693b060ad2d55cb350d458d151edf7d0f8d0babb42977"
]);

export const repair = internalMutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    entries: v.array(v.object({
      message_id: v.id("messages"),
      expected_content: v.string(),
      source_message_id: v.id("messages"),
      source_call_id: v.string(),
      expected_source_input: v.string(),
    })),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.entries.length > 32 || args.entries.reduce((size, e) => size + e.expected_content.length + e.expected_source_input.length, 0) > 512_000) {
      throw new Error("Agent prompt repair batch is too large");
    }
    const parent = await ctx.db.get(args.parent_conversation_id);
    const child = await ctx.db.get(args.child_conversation_id);
    if (!parent || !child || parent.user_id !== child.user_id || parent._id === child._id ||
      child.parent_conversation_id !== parent._id || !child.is_subagent) {
      throw new Error("Agent prompt repair requires an owned parent-child relationship");
    }
    const patches = [];
    const seen = new Set<string>();
    for (const entry of args.entries) {
      if (seen.has(entry.message_id)) throw new Error("Duplicate repair message");
      seen.add(entry.message_id);
      const tuple = JSON.stringify([args.parent_conversation_id, args.child_conversation_id, entry.message_id, entry.expected_content, entry.source_message_id, entry.source_call_id, entry.expected_source_input]);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tuple));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (!reviewedTuples.has(fingerprint)) throw new Error("Agent prompt repair tuple was not reviewed");
      const message = await ctx.db.get(entry.message_id);
      const source = await ctx.db.get(entry.source_message_id);
      if (!message || message.conversation_id !== child._id || message.role !== "user" || message.from_user_id ||
        !source || source.conversation_id !== parent._id || source.role !== "assistant" ||
        !source.tool_calls?.some(call => call.id === entry.source_call_id && call.input === entry.expected_source_input && /agent-(?:spawn|send)\.sh/.test(call.input)) ||
        Math.abs(message.timestamp - source.timestamp) > 300_000) {
        throw new Error("Agent prompt repair provenance does not match");
      }
      const content = formatSessionMessage(parent._id, entry.expected_content)
        .replace('">', `" source-message="${source._id}">`);
      if (message.content === content) continue;
      if (message.content !== entry.expected_content) throw new Error("Agent prompt changed since the repair was prepared");
      patches.push({ id: message._id, content });
    }
    if (args.dry_run !== false) return { dry_run: true, changed: patches.length };
    for (const patch of patches) {
      await ctx.db.patch(patch.id, { content: patch.content });
      const mirror = await ctx.db.query("message_search_recent")
        .withIndex("by_message_id", q => q.eq("message_id", patch.id)).first();
      if (mirror) await ctx.db.patch(mirror._id, { content: patch.content.slice(0, 32_000) });
    }
    if (patches.length) await ctx.db.patch(child._id, { transcript_revision: (child.transcript_revision ?? 0) + 1 });
    return { dry_run: false, changed: patches.length };
  },
});
