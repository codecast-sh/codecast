// The lane's look comes from the family it shares with Whisk
// (@platform/design): its token sheet and its three faces (Instrument Sans,
// Newsreader, Fragment Mono), bundled the way Whisk bundles them, so they
// load from this origin with the lane's chunk and never from a third party.
// Imported for its side effects by every lane surface that renders outside
// the other: the shell and /welcome.
import "@platform/design/fonts";
import "@platform/design/tokens.css";
