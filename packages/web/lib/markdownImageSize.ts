import { createContext } from "react";

/** How an author asked an image to render, through the markdown title slot:
 *  `![caption](url "wide")`. `wide` takes the column and shows the whole image,
 *  `small` is a thumbnail, `whole` shows all of it at its own shape (a
 *  landscape across the column, a portrait at full height), anything else is
 *  auto (narrow, collapsed past a fixed height, widened for strips). */
export type ImageSize = "auto" | "wide" | "small" | "whole";

/** The size an unhinted image takes: auto in a transcript, whole where images
 *  are the point (an article). Its own module so components/tools/MarkdownImages
 *  stays a Fast Refresh boundary. */
export const MarkdownImageSize = createContext<ImageSize>("auto");
