import { workspaceNameOf, workspaceColorOf } from "../../lib/projectColors";

const FOLDER_PATH = "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z";

/** A sidebar folder row's icon. In Modern the folder wears its workspace
 *  colour, the colour every session tile from it is drawn in (WorkspaceTile),
 *  wrapped so a rail rule that inks a row's own svg leaves it be. Classic and
 *  Minimal draw the plain svg they always have. */
export function FolderIcon({ dir, modern }: { dir: string; modern: boolean }) {
  if (!modern) return (
    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={FOLDER_PATH} />
    </svg>
  );
  return (
    <span className={`flex flex-shrink-0 ${workspaceColorOf(workspaceNameOf({ project_path: dir })).text}`}>
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={FOLDER_PATH} />
      </svg>
    </span>
  );
}
