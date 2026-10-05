// What the line's eval station writes (eval-result.json, design LE8): each
// surface a branch touches, replayed on the base and on the branch, with the
// separation verdict, the gates that failed, and the freezes whose verdict
// flipped. The change card (LE10) reads its eval check and its examples here.
//
// The shapes live in @platform/evals/contract, beside the code that builds
// them (@platform/evals/analysis buildEvalResult). This path stays so the
// change card and convex keep reading them from shared.

export type {
  EvalFlip,
  EvalRep,
  EvalRepsFile,
  EvalRepsFreeze,
  EvalRepsSide,
  EvalRepsSurface,
  EvalResult,
  EvalRunSet,
  EvalSeparation,
  EvalSurfaceResult,
} from "@platform/evals/contract";
