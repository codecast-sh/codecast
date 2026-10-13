// The pages an app's link never shows, each in its own chunk.
import { lazyPart } from "../lib/lazyPart";

export const Home = lazyPart(() => import("./Home").then((m) => m.Home));
export const NotFound = lazyPart(() => import("./NotFound").then((m) => m.NotFound));
