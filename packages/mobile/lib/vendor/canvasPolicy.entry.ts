import { sanitizeCanvasCss } from "../../../shared/render/canvasCss";
(globalThis as unknown as { sanitizeCanvasCss: typeof sanitizeCanvasCss }).sanitizeCanvasCss = sanitizeCanvasCss;
