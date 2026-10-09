// Which sheet opens for each kind of company object: one entry per kind, so
// the panel, a test and a later kind add one line here and nothing else. A
// role's sheet is the head drawn above its conversation (OrgDetailPanel).
import type { ComponentType } from "react";
import type { OrgObjectKind } from "@codecast/shared/entities";
import type { SheetRef } from "./sheetStack";
import { GoalSheet } from "./sheets/GoalSheet";
import { PersonSheet } from "./sheets/PersonSheet";
import { ProjectSheet } from "./sheets/ProjectSheet";
import { RoleSheet } from "./sheets/RoleSheet";

export const SHEETS: Record<OrgObjectKind, ComponentType<{ sheet: SheetRef }>> = {
  initiative: GoalSheet,
  project: ProjectSheet,
  role: RoleSheet,
  person: PersonSheet,
};
