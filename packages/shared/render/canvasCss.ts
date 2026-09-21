import { generate, parse, walk, type CssNode } from "css-tree";

const RULES = new Set(["media", "supports", "container", "layer", "keyframes", "-webkit-keyframes", "font-face", "property", "starting-style"]);
const FUNCTIONS = new Set(("var env calc min max clamp round mod rem abs sign pow sqrt hypot log exp sin cos tan asin acos atan atan2 " +
  "rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark contrast-color " +
  "linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient " +
  "matrix matrix3d translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy perspective " +
  "blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia " +
  "cubic-bezier steps linear repeat minmax fit-content circle ellipse inset polygon path rect xywh local format tech").split(" "));

function safeValue(node: CssNode): boolean {
  let safe = true;
  walk(node, (part) => {
    if (part.type === "Raw") safe = false;
    if (part.type === "Url" && !/^(#|data:)/i.test(part.value)) safe = false;
    if (part.type === "Function" && !FUNCTIONS.has(part.name.toLowerCase())) safe = false;
  });
  return safe;
}

export function sanitizeCanvasCss(css: string, context: "stylesheet" | "declarationList" | "value" = "stylesheet"): string {
  let ast: CssNode;
  try {
    ast = parse(css, { context, parseCustomProperty: true });
  } catch {
    return "";
  }
  if (context === "value") return safeValue(ast) ? generate(ast) : "none";
  walk(ast, (node, item, list) => {
      if (!item || !list) return;
      if (node.type === "Raw" ||
          (node.type === "Declaration" && !safeValue(node.value)) ||
          (node.type === "Atrule" && (!RULES.has(node.name.toLowerCase()) || (node.prelude && !safePrelude(node.prelude)))) ||
          (node.type === "Rule" && !safePrelude(node.prelude))) {
        list.remove(item);
        return walk.skip;
      }
  });
  return generate(ast);
}

function safePrelude(node: CssNode): boolean {
  let safe = true;
  walk(node, (part) => { if (part.type === "Raw") safe = false; });
  return safe;
}
