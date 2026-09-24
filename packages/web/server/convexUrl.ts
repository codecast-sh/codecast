// The Convex deployment the web server and its pages talk to. Its own module so
// the response policy can name it without constructing a Convex client.
export const CONVEX_URL = process.env.VITE_CONVEX_URL || "https://convex.codecast.sh";
