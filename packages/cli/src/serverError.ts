/**
 * The server's own sentence out of a Convex client error, which wraps it in
 * request ids and a stack ("… Server Error\nUncaught Error: <sentence>\n at …").
 */
export function serverErrorLine(msg: string): string {
  const m = /Uncaught (?:Error|ConvexError): ([^\n]*)/.exec(msg);
  return (m ? m[1] : msg.split("\n")[0]).trim();
}
