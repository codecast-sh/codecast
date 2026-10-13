// The company's lines and summaries (cohesive build spec §6): one line per
// kind on one grid, and one summary per kind for hover cards, sheet heads and
// map cards. Containers that hold lines wear LINE_SCOPE (LINE_COMPACT for a
// sheet's Carried by).
export { LineBody, ObjectLine, type LineGhost, type LineKind, type ObjectLineProps } from "./ObjectLine";
export { GoalGlyph, GoalLine, GoalMeasure, GoalOwnerPick, GoalStatusPick, type GoalLineProps } from "./GoalLine";
export { ProjectGlyph, ProjectLead, ProjectLine, ProjectState, ProjectWork, type ProjectLineProps } from "./ProjectLine";
export { RoleLine, RoleState, type RoleLineProps } from "./RoleLine";
export { PersonLine, PersonPresence, type PersonLineProps } from "./PersonLine";
export { goalFacts, personCarries, personFacts, projectFacts, projectSays, roleCarries, roleFacts, sinceWord, type LineFacts, type LinePerson, type LineRole } from "./lineFacts";
export { GoalSummary, ObjectSummary, PersonSummary, ProjectSummary, RoleSummary, SummaryFrame } from "./ObjectSummary";
export { usePersonHead, useRoleHead } from "./useHeads";
export { LINE_COMPACT, LINE_SCOPE, lineProjectOf, namedLead, type LineContext, type LineProject, type LineProjectRow } from "./lineData";
export { proposalChangeHref, useLineOpen, useProposalOpen, type LineTarget } from "./lineOpen";
export { lightChanges, useChangeLit } from "./changeLight";
