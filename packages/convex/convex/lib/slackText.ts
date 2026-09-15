// Slack mrkdwn ↔ codecast markdown. Pure functions, no I/O, shared by the
// inbound apply path (a Slack line becomes a chat row) and the outbound push
// (a chat row becomes a Slack post). The two directions are not exact inverses
// — Slack has no headers, tables or nested emphasis — but a line that makes the
// round trip must still read as the same sentence, and nothing a Slack person
// typed may turn into a codecast mention of somebody they did not name.

// ── Emoji shortcodes ─────────────────────────────────────────────────────────
// Slack writes reactions and inline emoji as :names:. The chat stores unicode
// (chatText.isValidEmoji refuses anything else), so both directions need this
// table. It is the working set people actually react with, not the whole
// standard; an unknown name stays as text inbound and is skipped outbound.
const EMOJI_BY_NAME: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎",
  heart: "❤️", hearts: "💕", blue_heart: "💙", green_heart: "💚", yellow_heart: "💛", purple_heart: "💜", orange_heart: "🧡", black_heart: "🖤", white_heart: "🤍", broken_heart: "💔", heart_eyes: "😍", sparkling_heart: "💖",
  eyes: "👀", eye: "👁️", white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️", x: "❌", negative_squared_cross_mark: "❎", heavy_multiplication_x: "✖️",
  tada: "🎉", confetti_ball: "🎊", rocket: "🚀", fire: "🔥", sparkles: "✨", star: "⭐", star2: "🌟", zap: "⚡", boom: "💥", "100": "💯",
  joy: "😂", rolling_on_the_floor_laughing: "🤣", rofl: "🤣", smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", satisfied: "😆", sweat_smile: "😅", wink: "😉", blush: "😊", innocent: "😇", slightly_smiling_face: "🙂", upside_down_face: "🙃", relaxed: "☺️", yum: "😋", stuck_out_tongue: "😛", stuck_out_tongue_winking_eye: "😜", zany_face: "🤪", stuck_out_tongue_closed_eyes: "😝", money_mouth_face: "🤑", hugging_face: "🤗", face_with_hand_over_mouth: "🤭", shushing_face: "🤫", thinking_face: "🤔", zipper_mouth_face: "🤐", face_with_raised_eyebrow: "🤨", neutral_face: "😐", expressionless: "😑", no_mouth: "😶", smirk: "😏", unamused: "😒", face_with_rolling_eyes: "🙄", grimacing: "😬", lying_face: "🤥", relieved: "😌", pensive: "😔", sleepy: "😪", drooling_face: "🤤", sleeping: "😴", mask: "😷", face_with_thermometer: "🤒", face_with_head_bandage: "🤕", nauseated_face: "🤢", face_vomiting: "🤮", sneezing_face: "🤧", hot_face: "🥵", cold_face: "🥶", woozy_face: "🥴", dizzy_face: "😵", exploding_head: "🤯", face_with_cowboy_hat: "🤠", partying_face: "🥳", sunglasses: "😎", nerd_face: "🤓", face_with_monocle: "🧐", confused: "😕", worried: "😟", slightly_frowning_face: "🙁", white_frowning_face: "☹️", open_mouth: "😮", hushed: "😯", astonished: "😲", flushed: "😳", pleading_face: "🥺", frowning: "😦", anguished: "😧", fearful: "😨", cold_sweat: "😰", disappointed_relieved: "😥", cry: "😢", sob: "😭", scream: "😱", confounded: "😖", persevere: "😣", disappointed: "😞", sweat: "😓", weary: "😩", tired_face: "😫", yawning_face: "🥱", triumph: "😤", rage: "😡", angry: "😠", face_with_symbols_on_mouth: "🤬", smiling_imp: "😈", imp: "👿", skull: "💀", skull_and_crossbones: "☠️", hankey: "💩", poop: "💩", clown_face: "🤡", ghost: "👻", alien: "👽", robot_face: "🤖", melting_face: "🫠", saluting_face: "🫡", face_holding_back_tears: "🥹", smiling_face_with_3_hearts: "🥰", star_struck: "🤩", face_with_peeking_eye: "🫣",
  wave: "👋", raised_back_of_hand: "🤚", hand: "✋", raised_hand: "✋", vulcan_salute: "🖖", ok_hand: "👌", pinched_fingers: "🤌", pinching_hand: "🤏", v: "✌️", crossed_fingers: "🤞", i_love_you_hand_sign: "🤟", the_horns: "🤘", call_me_hand: "🤙", point_left: "👈", point_right: "👉", point_up_2: "👆", middle_finger: "🖕", point_down: "👇", point_up: "☝️", fist: "✊", facepunch: "👊", punch: "👊", left_facing_fist: "🤛", right_facing_fist: "🤜", clap: "👏", raised_hands: "🙌", open_hands: "👐", palms_up_together: "🤲", handshake: "🤝", pray: "🙏", muscle: "💪", writing_hand: "✍️", nail_care: "💅", selfie: "🤳", brain: "🧠", man_shrugging: "🤷‍♂️", woman_shrugging: "🤷‍♀️", shrug: "🤷", man_facepalming: "🤦‍♂️", woman_facepalming: "🤦‍♀️", facepalm: "🤦", bow: "🙇", dancer: "💃", man_dancing: "🕺", runner: "🏃", running: "🏃",
  see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊", monkey_face: "🐵", dog: "🐶", cat: "🐱", unicorn_face: "🦄", bee: "🐝", bug: "🐛", snail: "🐌", turtle: "🐢", octopus: "🐙", whale: "🐳", penguin: "🐧", owl: "🦉", fox_face: "🦊", bear: "🐻", panda_face: "🐼", koala: "🐨", chicken: "🐔", hatching_chick: "🐣", duck: "🦆", eagle: "🦅", butterfly: "🦋", crab: "🦀", shrimp: "🦐", dragon: "🐉", t_rex: "🦖",
  coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻", wine_glass: "🍷", cocktail: "🍸", champagne: "🍾", clinking_glasses: "🥂", pizza: "🍕", hamburger: "🍔", taco: "🌮", burrito: "🌯", sushi: "🍣", ramen: "🍜", cake: "🍰", birthday: "🎂", cookie: "🍪", doughnut: "🍩", popcorn: "🍿", apple: "🍎", banana: "🍌", avocado: "🥑", hot_pepper: "🌶️", eggplant: "🍆", peach: "🍑", cherries: "🍒", strawberry: "🍓", watermelon: "🍉", lemon: "🍋", croissant: "🥐", egg: "🥚", bacon: "🥓",
  seedling: "🌱", herb: "🌿", four_leaf_clover: "🍀", cactus: "🌵", palm_tree: "🌴", evergreen_tree: "🌲", deciduous_tree: "🌳", sunflower: "🌻", rose: "🌹", cherry_blossom: "🌸", tulip: "🌷", bouquet: "💐", earth_americas: "🌎", earth_africa: "🌍", earth_asia: "🌏", sunny: "☀️", partly_sunny: "⛅", cloud: "☁️", rain_cloud: "🌧️", snowflake: "❄️", snowman: "⛄", umbrella: "☔", rainbow: "🌈", ocean: "🌊", volcano: "🌋", mountain: "⛰️", full_moon: "🌕", crescent_moon: "🌙", new_moon_with_face: "🌚", full_moon_with_face: "🌝", comet: "☄️",
  soccer: "⚽", basketball: "🏀", football: "🏈", baseball: "⚾", tennis: "🎾", "8ball": "🎱", trophy: "🏆", medal: "🏅", first_place_medal: "🥇", second_place_medal: "🥈", third_place_medal: "🥉", dart: "🎯", video_game: "🎮", game_die: "🎲", jigsaw: "🧩", art: "🎨", musical_note: "🎵", notes: "🎶", microphone: "🎤", headphones: "🎧", guitar: "🎸", drum_with_drumsticks: "🥁", trumpet: "🎺", saxophone: "🎷", violin: "🎻", movie_camera: "🎥", clapper: "🎬", tv: "📺", camera: "📷", camera_with_flash: "📸",
  computer: "💻", desktop_computer: "🖥️", keyboard: "⌨️", iphone: "📱", telephone_receiver: "📞", phone: "☎️", battery: "🔋", electric_plug: "🔌", bulb: "💡", flashlight: "🔦", mag: "🔍", mag_right: "🔎", microscope: "🔬", telescope: "🔭", satellite_antenna: "📡", gear: "⚙️", wrench: "🔧", hammer: "🔨", hammer_and_wrench: "🛠️", nut_and_bolt: "🔩", pick: "⛏️", toolbox: "🧰", magnet: "🧲", test_tube: "🧪", dna: "🧬", pill: "💊", syringe: "💉", bomb: "💣", knife: "🔪", hocho: "🔪", shield: "🛡️", key: "🔑", lock: "🔒", unlock: "🔓", closed_lock_with_key: "🔐", bell: "🔔", no_bell: "🔕", loudspeaker: "📢", mega: "📣", speech_balloon: "💬", thought_balloon: "💭", left_speech_bubble: "🗨️", right_anger_bubble: "🗯️", hourglass: "⌛", hourglass_flowing_sand: "⏳", stopwatch: "⏱️", alarm_clock: "⏰", clock1: "🕐", calendar: "📆", date: "📅", spiral_calendar_pad: "🗓️", pushpin: "📌", round_pushpin: "📍", paperclip: "📎", link: "🔗", scissors: "✂️", pencil2: "✏️", memo: "📝", pencil: "📝", black_nib: "✒️", fountain_pen: "🖋️", book: "📖", books: "📚", notebook: "📓", ledger: "📒", page_facing_up: "📄", page_with_curl: "📃", bookmark_tabs: "📑", scroll: "📜", newspaper: "📰", chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉", bar_chart: "📊", clipboard: "📋", file_folder: "📁", open_file_folder: "📂", card_index_dividers: "🗂️", wastebasket: "🗑️", package: "📦", inbox_tray: "📥", outbox_tray: "📤", envelope: "✉️", email: "📧", "e-mail": "📧", incoming_envelope: "📨", mailbox: "📫", moneybag: "💰", dollar: "💵", money_with_wings: "💸", credit_card: "💳", gem: "💎", crown: "👑", ring: "💍", gift: "🎁", balloon: "🎈", ribbon: "🎀", christmas_tree: "🎄", jack_o_lantern: "🎃", fireworks: "🎆", sparkler: "🎇",
  warning: "⚠️", no_entry: "⛔", no_entry_sign: "🚫", exclamation: "❗", heavy_exclamation_mark: "❗", grey_exclamation: "❕", question: "❓", grey_question: "❔", bangbang: "‼️", interrobang: "⁉️", recycle: "♻️", white_circle: "⚪", black_circle: "⚫", red_circle: "🔴", large_blue_circle: "🔵", large_green_circle: "🟢", large_yellow_circle: "🟡", large_orange_circle: "🟠", large_purple_circle: "🟣", small_red_triangle: "🔺", small_red_triangle_down: "🔻", arrow_up: "⬆️", arrow_down: "⬇️", arrow_left: "⬅️", arrow_right: "➡️", arrows_counterclockwise: "🔄", repeat: "🔁", fast_forward: "⏩", rewind: "⏪", arrow_forward: "▶️", double_vertical_bar: "⏸️", black_square_for_stop: "⏹️", black_circle_for_record: "⏺️", heavy_plus_sign: "➕", heavy_minus_sign: "➖", heavy_division_sign: "➗", infinity: "♾️", hash: "#️⃣", keycap_star: "*️⃣", zero: "0️⃣", one: "1️⃣", two: "2️⃣", three: "3️⃣", four: "4️⃣", five: "5️⃣", six: "6️⃣", seven: "7️⃣", eight: "8️⃣", nine: "9️⃣", keycap_ten: "🔟", ok: "🆗", new: "🆕", cool: "🆒", free: "🆓", up: "🆙", sos: "🆘", "100_": "💯", checkered_flag: "🏁", triangular_flag_on_post: "🚩", crossed_flags: "🎌", waving_white_flag: "🏳️", waving_black_flag: "🏴", "rainbow-flag": "🏳️‍🌈", pirate_flag: "🏴‍☠️",
  car: "🚗", taxi: "🚕", bus: "🚌", truck: "🚚", bike: "🚲", airplane: "✈️", helicopter: "🚁", ship: "🚢", anchor: "⚓", house: "🏠", office: "🏢", hospital: "🏥", school: "🏫", church: "⛪", tent: "⛺", statue_of_liberty: "🗽", construction: "🚧", traffic_light: "🚦", world_map: "🗺️", compass: "🧭",
  sleeping_accommodation: "🛌", bath: "🛀", zzz: "💤", dash: "💨", sweat_drops: "💦", droplet: "💧", speech_bubble: "💬", dizzy: "💫", anger: "💢", collision: "💥", hole: "🕳️", eyeglasses: "👓", dark_sunglasses: "🕶️", necktie: "👔", shirt: "👕", tshirt: "👕", jeans: "👖", dress: "👗", bikini: "👙", high_heel: "👠", athletic_shoe: "👟", tophat: "🎩", mortar_board: "🎓", handbag: "👜", briefcase: "💼", school_satchel: "🎒", lipstick: "💄", baby: "👶", boy: "👦", girl: "👧", man: "👨", woman: "👩", older_man: "👴", older_woman: "👵", cop: "👮", detective: "🕵️", santa: "🎅", angel: "👼", princess: "👸", prince: "🤴", superhero: "🦸", supervillain: "🦹", mage: "🧙", zombie: "🧟", genie: "🧞", technologist: "🧑‍💻", male_technologist: "👨‍💻", female_technologist: "👩‍💻", scientist: "🧑‍🔬", firefighter: "🧑‍🚒", astronaut: "🧑‍🚀", busts_in_silhouette: "👥", bust_in_silhouette: "👤", family: "👪", couple: "👫", two_men_holding_hands: "👬", two_women_holding_hands: "👭", people_holding_hands: "🧑‍🤝‍🧑", footprints: "👣", ear: "👂", nose: "👃", tongue: "👅", lips: "👄", tooth: "🦷", bone: "🦴", speaking_head_in_silhouette: "🗣️",
  slack: "💬", slightly_smiling: "🙂", simple_smile: "🙂", heavy_heart_exclamation_mark_ornament: "❣️", two_hearts: "💕", revolving_hearts: "💞", heartbeat: "💓", heartpulse: "💗", cupid: "💘", gift_heart: "💝", heart_decoration: "💟", peace_symbol: "☮️", latin_cross: "✝️", star_of_david: "✡️", om_symbol: "🕉️", wheel_of_dharma: "☸️", yin_yang: "☯️", six_pointed_star: "🔯", menorah_with_nine_branches: "🕎", atom_symbol: "⚛️", radioactive_sign: "☢️", biohazard_sign: "☣️", medical_symbol: "⚕️", wheelchair: "♿", mens: "🚹", womens: "🚺", restroom: "🚻", potable_water: "🚰", trident: "🔱", fleur_de_lis: "⚜️", beginner: "🔰", o: "⭕", white_large_square: "⬜", black_large_square: "⬛", large_blue_diamond: "🔷", large_orange_diamond: "🔶", small_blue_diamond: "🔹", small_orange_diamond: "🔸", diamond_shape_with_a_dot_inside: "💠", radio_button: "🔘", white_square_button: "🔳", black_square_button: "🔲", checkered: "🏁",
  eyes_shifty: "👀", handshake_: "🤝", ok_woman: "🙆‍♀️", ok_man: "🙆‍♂️", no_good: "🙅", raising_hand: "🙋", person_with_pouting_face: "🙎", person_frowning: "🙍", information_desk_person: "💁", tipping_hand_person: "💁", massage: "💆", haircut: "💇", walking: "🚶", standing_person: "🧍", kneeling_person: "🧎", couplekiss: "💏", couple_with_heart: "💑", man_in_business_suit_levitating: "🕴️", speak: "🗣️", chart: "💹", tickets: "🎟️", ticket: "🎫", admission_tickets: "🎟️", performing_arts: "🎭", circus_tent: "🎪", carousel_horse: "🎠", ferris_wheel: "🎡", roller_coaster: "🎢", hotsprings: "♨️", label: "🏷️", moneybag_: "💰", chart_increasing: "📈", stopwatch_: "⏱️", timer_clock: "⏲️", mantelpiece_clock: "🕰️", watch: "⌚", radio: "📻", pager: "📟", fax: "📠", vhs: "📼", cd: "💿", dvd: "📀", minidisc: "💽", floppy_disk: "💾", printer: "🖨️", trackball: "🖲️", mouse_two_button: "🖱️", joystick: "🕹️", compression: "🗜️", abacus: "🧮", film_frames: "🎞️", film_projector: "📽️", level_slider: "🎚️", control_knobs: "🎛️", studio_microphone: "🎙️", postal_horn: "📯", speaker: "🔈", sound: "🔉", loud_sound: "🔊", mute: "🔇",
};

const NAME_BY_EMOJI: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  // First name wins, so the canonical Slack names (listed first per glyph) are
  // what outbound reactions carry.
  for (const [name, glyph] of Object.entries(EMOJI_BY_NAME)) {
    if (!(glyph in out)) out[glyph] = name;
  }
  // Slack accepts these bare names for the two most common reactions.
  out["👍"] = "+1";
  out["👎"] = "-1";
  return out;
})();

const SKIN_TONE_RE = /::skin-tone-[2-6]$/;
const SKIN_TONE_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const VARIATION_SELECTOR_RE = /️/g;

/** A Slack emoji name (with or without colons, with or without a skin tone) to
 *  its unicode glyph, or null when the name is not in the working set. */
export function shortcodeToEmoji(name: string): string | null {
  const bare = name.replace(/^:|:$/g, "").replace(SKIN_TONE_RE, "");
  return EMOJI_BY_NAME[bare] ?? null;
}

/** A unicode emoji to the Slack name its reaction API wants, or null when Slack
 *  has no name we know for it. Skin tones and variation selectors are dropped
 *  first so 👍🏽 reacts as +1. */
export function emojiToShortcode(emoji: string): string | null {
  const direct = NAME_BY_EMOJI[emoji];
  if (direct) return direct;
  const stripped = emoji.replace(SKIN_TONE_MODIFIER_RE, "").replace(VARIATION_SELECTOR_RE, "");
  if (NAME_BY_EMOJI[stripped]) return NAME_BY_EMOJI[stripped];
  for (const [glyph, name] of Object.entries(NAME_BY_EMOJI)) {
    if (glyph.replace(VARIATION_SELECTOR_RE, "") === stripped) return name;
  }
  return null;
}

/** Replace :name: shortcodes in prose with their glyphs. Unknown names stay. */
export function replaceShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+\-']+)(?:::skin-tone-[2-6])?:/g, (whole, name: string) => {
    const glyph = EMOJI_BY_NAME[name];
    return glyph ?? whole;
  });
}

// ── Entities and code protection ─────────────────────────────────────────────

export function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function encodeSlackEntities(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Code is lifted out before any formatting rule runs and put back after, so a
// `*` inside a snippet never becomes emphasis. Fences first, then spans.
const CODE_TOKEN = "\u0000C";
function protectCode(text: string, onCode: (code: string) => string): { text: string; restore: (s: string) => string } {
  const stash: string[] = [];
  const keep = (code: string) => {
    stash.push(onCode(code));
    return `${CODE_TOKEN}${stash.length - 1}${CODE_TOKEN}`;
  };
  let out = text.replace(/```[\s\S]*?```/g, keep);
  out = out.replace(/`[^`\n]+`/g, keep);
  return {
    text: out,
    restore: (s: string) => s.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, "g"), (_m, i) => stash[Number(i)]),
  };
}

// ── Slack → codecast ─────────────────────────────────────────────────────────

export type SlackInboundResolver = {
  /** A Slack user id to how the line should name them: a codecast handle when
   *  the person is a mapped teammate (renders as a real mention), else a
   *  display name (renders as bold text so it can never page the wrong
   *  teammate). Null when nothing is known. */
  user: (id: string) => { handle?: string | null; name?: string | null } | null;
  channel?: (id: string) => string | null;
  usergroup?: (id: string) => string | null;
};

// Word-boundary emphasis, the way Slack's own parser decides it: the marker
// must open at a line start or after whitespace/punctuation and close before
// the same, and the wrapped text may not start or end with whitespace.
const OPEN = String.raw`(^|[\s(\[{"'])`;
const CLOSE = String.raw`(?=$|[\s.,!?;:)\]}"'])`;
function emphasisRe(marker: string): RegExp {
  const m = marker.replace(/[*~_]/g, (c) => `\\${c}`);
  return new RegExp(`${OPEN}${m}(?!\\s)([^${m}\\n]*?[^\\s${m}])${m}${CLOSE}`, "g");
}
const BOLD_RE = emphasisRe("*");
const ITALIC_RE = emphasisRe("_");
const STRIKE_RE = emphasisRe("~");

function angleToken(inner: string, resolve: SlackInboundResolver): string {
  // <@U123> / <@U123|name>
  let m = /^@([A-Z0-9]+)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const known = resolve.user(m[1]);
    if (known?.handle) return `@${known.handle}`;
    const name = known?.name || m[2] || m[1];
    // A zero width space after the @ keeps this out of the mention grammar on
    // both server and client: a Slack name must never page a codecast teammate
    // who happens to share it.
    return `**@\u200b${name}**`;
  }
  // <#C123|name> / <#C123>
  m = /^#([A-Z0-9]+)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const name = m[2] || resolve.channel?.(m[1]) || m[1];
    return `#${name}`;
  }
  // <!here> <!channel> <!everyone> <!subteam^S1|@grp> <!date^…|fallback>
  m = /^!([a-z]+)(?:\^([^|]*))?(?:\|(.*))?$/.exec(inner);
  if (m) {
    const kind = m[1];
    if (kind === "here" || kind === "channel" || kind === "everyone") return "@here";
    if (kind === "subteam") {
      const label = m[3] || resolve.usergroup?.(m[2] ?? "") || "group";
      return `**@\u200b${label.replace(/^@/, "")}**`;
    }
    if (kind === "date") return m[3] || m[2] || "";
    return m[3] || "";
  }
  // <mailto:a@b|a@b> / <tel:…|…>
  m = /^(mailto|tel):([^|]*)(?:\|(.*))?$/.exec(inner);
  if (m) return m[3] || m[2];
  // <https://url|label> / <https://url>
  m = /^(https?:\/\/[^|]*)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const url = m[1];
    const label = m[2];
    if (!label || label === url) return url;
    return `[${label}](${url})`;
  }
  return inner;
}

/** Convert one Slack mrkdwn message body to codecast markdown. */
export function slackToMarkdown(text: string, resolve: SlackInboundResolver): string {
  if (!text) return "";
  const { text: protectedText, restore } = protectCode(text, (code) => decodeSlackEntities(code));
  let out = protectedText;
  // Angle tokens carry raw < >; everything else Slack sends is entity-escaped.
  out = out.replace(/<([^<>\n]+)>/g, (_m, inner: string) => angleToken(inner, resolve));
  out = decodeSlackEntities(out);
  out = out.replace(BOLD_RE, "$1**$2**");
  out = out.replace(STRIKE_RE, "$1~~$2~~");
  out = out.replace(ITALIC_RE, "$1*$2*");
  // Slack bullets arrive as "• ", and a leading "# " would become a header here.
  out = out
    .split("\n")
    .map((line) => {
      let l = line.replace(/^(\s*)•\s+/, "$1- ");
      if (/^\s*#{1,6}\s/.test(l)) l = l.replace(/^(\s*)#/, "$1\\#");
      return l;
    })
    .join("\n");
  out = replaceShortcodes(out);
  return restore(out).trim();
}

// Slack "attachments" are the legacy unfurl / bot-card shape (title, text,
// fields, footer). Rendered as a quote card so a GitHub or Linear notification
// mirrored from Slack reads as a card, not as a wall of URLs.
export type SlackAttachment = {
  title?: string;
  title_link?: string;
  text?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  footer?: string;
  image_url?: string;
  thumb_url?: string;
  fields?: Array<{ title?: string; value?: string; short?: boolean }>;
  from_url?: string;
  service_name?: string;
};

export function slackAttachmentsToMarkdown(
  attachments: SlackAttachment[] | undefined,
  resolve: SlackInboundResolver,
): string {
  if (!attachments || attachments.length === 0) return "";
  const cards: string[] = [];
  for (const a of attachments) {
    if (!a || typeof a !== "object") continue;
    const lines: string[] = [];
    if (a.pretext) lines.push(slackToMarkdown(a.pretext, resolve));
    const head: string[] = [];
    if (a.service_name || a.author_name) head.push(`*${a.author_name || a.service_name}*`);
    if (a.title) head.push(a.title_link ? `**[${a.title}](${a.title_link})**` : `**${a.title}**`);
    if (head.length > 0) lines.push(head.join(" · "));
    if (a.text) lines.push(slackToMarkdown(a.text, resolve));
    for (const f of a.fields ?? []) {
      if (!f) continue;
      const t = f.title ? `**${f.title}** ` : "";
      lines.push(`${t}${slackToMarkdown(f.value ?? "", resolve)}`.trim());
    }
    if (a.image_url) lines.push(`![](${a.image_url})`);
    if (a.footer) lines.push(`*${slackToMarkdown(a.footer, resolve)}*`);
    if (lines.length === 0 && a.fallback) lines.push(slackToMarkdown(a.fallback, resolve));
    if (lines.length === 0) continue;
    cards.push(lines.map((l) => l.split("\n").map((x) => `> ${x}`).join("\n")).join("\n>\n"));
  }
  return cards.join("\n\n");
}

// ── codecast → Slack ─────────────────────────────────────────────────────────

export type SlackOutboundResolver = {
  /** A codecast mention handle to the Slack user id it should page, or null. */
  handleToSlackUser: (handle: string) => string | null;
  /** Absolute URL for an object short id (ct-12, pl-3, a session id) so a pill
   *  survives the trip as a link, or null to leave it as text. */
  entityUrl?: (shortId: string) => string | null;
};

const HANDLE_RE = /(^|[^\w/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})\b/g;
const ENTITY_ID_RE = /(^|[^\w-])((?:ct|pl|tr)-\d+)\b/g;

/** Convert codecast markdown to Slack mrkdwn. */
export function markdownToSlack(md: string, resolve: SlackOutboundResolver): string {
  if (!md) return "";
  const { text: protectedText, restore } = protectCode(md, (code) => encodeSlackEntities(code));
  let out = encodeSlackEntities(protectedText);
  // Images and links first: their URLs must not be touched by emphasis rules,
  // and a converted link is shielded so a `ct-12` in its label is not linked
  // a second time by the entity pass below.
  const links: string[] = [];
  const shield = (token: string) => {
    links.push(token);
    return `\u0000L${links.length - 1}\u0000`;
  };
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => shield(`<${url}|${alt || "image"}>`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => shield(`<${url}|${label}>`));
  // Headers: Slack has none; bold the line.
  out = out.replace(/^(\s*)#{1,6}\s+(.+?)\s*#*$/gm, "$1**$2**");
  // Emphasis. Single-star italic first, with lookarounds that refuse a star
  // that is part of a pair, so the bold made next is not re-read as italic.
  out = out.replace(/(^|[\s(])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)(?=$|[\s.,!?;:)])/gm, "$1_$2_");
  out = out.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "*$1*");
  out = out.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, "*$1*");
  out = out.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "~$1~");
  // Bullets.
  out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Mentions and broadcast.
  out = out.replace(/(^|[^\w/])@here\b/g, "$1<!here>");
  out = out.replace(HANDLE_RE, (whole, pre: string, handle: string) => {
    const uid = resolve.handleToSlackUser(handle.toLowerCase());
    return uid ? `${pre}<@${uid}>` : whole;
  });
  if (resolve.entityUrl) {
    out = out.replace(ENTITY_ID_RE, (whole, pre: string, id: string) => {
      const url = resolve.entityUrl!(id);
      return url ? `${pre}<${url}|${id}>` : whole;
    });
  }
  out = out.replace(/\u0000L(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  return restore(out).trim();
}

/** The name Slack shows over a mirrored codecast line. Agents are marked so a
 *  Slack reader never mistakes a machine for the teammate hosting it. */
export function slackDisplayName(author: { name: string; isAgent?: boolean; via?: string | null }): string {
  const base = author.name.trim() || "Someone";
  if (!author.isAgent) return base.slice(0, 80);
  const via = author.via ? ` · via ${author.via}` : "";
  return `${base} (agent${via})`.slice(0, 80);
}
