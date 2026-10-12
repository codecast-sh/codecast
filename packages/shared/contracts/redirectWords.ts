/** The words a human uses to redirect an agent. The same words the
 *  cast-lessons skill searches for (`cast search "don't|do not|..."`): a user
 *  turn matching this is kept when the session insight samples its turns. */
export const REDIRECT_WORDS = ["don't", "do not", "never", "stop", "wrong", "not like that", "instead", "revert"] as const;
export const REDIRECT_PATTERN = new RegExp(REDIRECT_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
