// The outcomes a station's record (workflow_runs.node_statuses[].outcome) can
// carry beyond "success" and "failure". A gate records the key a person
// answered with; a script station records "carried" when it ended red and the
// run went on past it on purpose, as its graph routes a success: change.cast's
// Local CI, still red after the session's turn on it, opens the pull request
// so GitHub's CI judges the change against main. Its node_status is
// "completed", and a reader draws it as neither passed nor failed.

/** A script station that ended red, and the run went on past it as its graph routes a success. */
export const CARRIED_OUTCOME = "carried";

/** The environment variable naming the file a script station writes its declared outcome to (`carried`). */
export const STATION_OUTCOME_ENV = "CAST_STATION_OUTCOME";

export const isCarriedOutcome = (outcome: string | null | undefined): boolean => outcome === CARRIED_OUTCOME;
