"use client";
// A project's About tab: what it is for, its charter, and the repositories its
// work lives in. Everything here edits in place through the store.
import { useMemo } from "react";
import { useInboxStore, type ProjectItem } from "../../../store/inboxStore";
import { useProjectLead } from "../../../hooks/useProjectLead";
import { charterOf } from "../../../components/charter/charterMeta";
import { CharterBlock } from "../../../components/charter/CharterBlock";
import { WrittenField } from "../../../components/initiatives/InitiativeRecord";
import { RepositoryLinks } from "../../../components/repo/RepositoryLinks";

export function ProjectAbout({ project }: { project: ProjectItem }) {
  const update = (fields: Record<string, unknown>) => useInboxStore.getState().updateProject(project._id, fields);
  const charter = useMemo(() => charterOf(project as unknown as Record<string, unknown>, "project"), [project]);
  const { roles } = useProjectLead(project._id);
  return (
    <div className="mx-auto flex max-w-[60rem] flex-col gap-8 px-4 py-6 sm:px-6" data-project-about-tab>
      <WrittenField name="purpose" label="What it is for" value={project.goal ?? ""} fallback={project.description} onSave={(goal) => update({ goal })} rows={4} placeholder="What this project is for, in one paragraph a new hire could act on." />
      <CharterBlock kind="project" title={project.title} charter={charter} canEdit onChange={update} roles={roles} hideOwner hideGoal plain />
      <RepositoryLinks projectId={project._id} />
    </div>
  );
}
