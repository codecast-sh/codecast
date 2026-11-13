// What the docs shots' offline Convex client answers: the Acme world's shared
// answers, plus the queries web surfaces subscribe to directly rather than
// reading the store.
import { ACME_ANSWERS, type AcmeAnswers } from "../acmeWorld/convexStub";

export const DOCS_ANSWERS: AcmeAnswers = {
  ...ACME_ANSWERS,
};
