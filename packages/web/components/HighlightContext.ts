import { createContext } from "react";

// The active in-conversation search query, provided by ConversationView and
// read by everything that renders message text (markdown, code blocks) so each
// can wrap its own hits in <mark data-search-highlight>. Lives in its own
// module so CodeBlock can read it without importing the 18k-line view.
export const HighlightContext = createContext<string | undefined>(undefined);
