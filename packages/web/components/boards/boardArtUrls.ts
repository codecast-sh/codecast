// The painted board illustrations (names in @codecast/shared/artifacts/boardArt.ts),
// one WebP per name in ./art: 256 px squares on a transparent ground, generated
// once with gpt-image-1.5 from one shared style prompt so the set reads as one
// family. boardArt.guard.test.ts keeps the names, the files and this map agreeing.
import type { BoardArt } from "@codecast/shared/artifacts/board";
import art_rocket from "./art/rocket.webp";
import art_map from "./art/map.webp";
import art_lightbulb from "./art/lightbulb.webp";
import art_target from "./art/target.webp";
import art_calendar from "./art/calendar.webp";
import art_clock from "./art/clock.webp";
import art_hourglass from "./art/hourglass.webp";
import art_flag from "./art/flag.webp";
import art_mountain from "./art/mountain.webp";
import art_trophy from "./art/trophy.webp";
import art_gift from "./art/gift.webp";
import art_truck from "./art/truck.webp";
import art_box from "./art/box.webp";
import art_cart from "./art/cart.webp";
import art_storefront from "./art/storefront.webp";
import art_money from "./art/money.webp";
import art_chart from "./art/chart.webp";
import art_piechart from "./art/piechart.webp";
import art_magnifier from "./art/magnifier.webp";
import art_megaphone from "./art/megaphone.webp";
import art_mail from "./art/mail.webp";
import art_chat from "./art/chat.webp";
import art_people from "./art/people.webp";
import art_person from "./art/person.webp";
import art_handshake from "./art/handshake.webp";
import art_heart from "./art/heart.webp";
import art_star from "./art/star.webp";
import art_thumbsup from "./art/thumbsup.webp";
import art_warning from "./art/warning.webp";
import art_bug from "./art/bug.webp";
import art_gear from "./art/gear.webp";
import art_wrench from "./art/wrench.webp";
import art_laptop from "./art/laptop.webp";
import art_phone from "./art/phone.webp";
import art_server from "./art/server.webp";
import art_database from "./art/database.webp";
import art_cloud from "./art/cloud.webp";
import art_lock from "./art/lock.webp";
import art_key from "./art/key.webp";
import art_shield from "./art/shield.webp";
import art_plug from "./art/plug.webp";
import art_code from "./art/code.webp";
import art_puzzle from "./art/puzzle.webp";
import art_book from "./art/book.webp";
import art_notebook from "./art/notebook.webp";
import art_clipboard from "./art/clipboard.webp";
import art_checklist from "./art/checklist.webp";
import art_pencil from "./art/pencil.webp";
import art_palette from "./art/palette.webp";
import art_camera from "./art/camera.webp";
import art_music from "./art/music.webp";
import art_coffee from "./art/coffee.webp";
import art_pie from "./art/pie.webp";
import art_berries from "./art/berries.webp";
import art_leaf from "./art/leaf.webp";
import art_sun from "./art/sun.webp";
import art_snowflake from "./art/snowflake.webp";
import art_fire from "./art/fire.webp";
import art_house from "./art/house.webp";
import art_building from "./art/building.webp";
import art_globe from "./art/globe.webp";
import art_plane from "./art/plane.webp";
import art_compass from "./art/compass.webp";
import art_tent from "./art/tent.webp";
import art_party from "./art/party.webp";
import art_road from "./art/road.webp";

export const BOARD_ART_URLS: Record<BoardArt, string> = {
  rocket: art_rocket,
  map: art_map,
  lightbulb: art_lightbulb,
  target: art_target,
  calendar: art_calendar,
  clock: art_clock,
  hourglass: art_hourglass,
  flag: art_flag,
  mountain: art_mountain,
  trophy: art_trophy,
  gift: art_gift,
  truck: art_truck,
  box: art_box,
  cart: art_cart,
  storefront: art_storefront,
  money: art_money,
  chart: art_chart,
  piechart: art_piechart,
  magnifier: art_magnifier,
  megaphone: art_megaphone,
  mail: art_mail,
  chat: art_chat,
  people: art_people,
  person: art_person,
  handshake: art_handshake,
  heart: art_heart,
  star: art_star,
  thumbsup: art_thumbsup,
  warning: art_warning,
  bug: art_bug,
  gear: art_gear,
  wrench: art_wrench,
  laptop: art_laptop,
  phone: art_phone,
  server: art_server,
  database: art_database,
  cloud: art_cloud,
  lock: art_lock,
  key: art_key,
  shield: art_shield,
  plug: art_plug,
  code: art_code,
  puzzle: art_puzzle,
  book: art_book,
  notebook: art_notebook,
  clipboard: art_clipboard,
  checklist: art_checklist,
  pencil: art_pencil,
  palette: art_palette,
  camera: art_camera,
  music: art_music,
  coffee: art_coffee,
  pie: art_pie,
  berries: art_berries,
  leaf: art_leaf,
  sun: art_sun,
  snowflake: art_snowflake,
  fire: art_fire,
  house: art_house,
  building: art_building,
  globe: art_globe,
  plane: art_plane,
  compass: art_compass,
  tent: art_tent,
  party: art_party,
  road: art_road,
};
