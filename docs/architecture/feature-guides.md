# Team features: the switch, the offer, and the guides

Org (`teams.features.org`) and Flows (`teams.features.line`) are team
features: one switch each in Settings, Team, Features, admin only. This
document says what the switch covers, how the app sells a feature a team has
not turned on, and how a feature guide is built. Sections are FG1 onward.

## FG1. Off means all of it

| Layer | Org off | Flows off |
|---|---|---|
| Web | `/org`, `/anchor`, `/org/<id>` show the feature landing (FG3); the workspace agent row, palette entry, anchor panel and role controls are gone | every Flows address lands on `/flows`, which shows the landing; Run through on a session header and the `flow`/`line` cards in transcripts are gone (`useWorkspaceFeature("line")`) |
| Surface registry | | `nav.line` is a feature surface (`surfaceRules.ts FEATURE_SURFACES`): no staff bypass, the switch alone decides |
| Server | org reads return nothing (`org.ts requireWorkspaceCaller`); a role's triggers wait (`agentTasks.roleTriggerHeld`) and fire again untouched once Org is back on | the line sweep starts no run in a workspace with Flows or Org off (`orgLine.linesRunIn`); a live flow runs as an Org role, so it needs both |
| CLI | `cast role`, `cast org`, `cast anchor` refuse (`requireOrgFeatureHook`) | `cast flow run`, `publish`, `import` and `on` refuse (`FlowDeps.requireFlows`); reading and runs already going are left alone; session start drops the `<flows>` line (`poolForCli.flows_on`) |

## FG2. On, offer, off

`workspaceFeatureState` (`shared/contracts/teamFeatures.ts`) reads a feature
in a workspace as one of three:

- **on**: the feature shows.
- **offer**: off, and its team never decided (no flag was ever stored). The
  app keeps one door open: the sidebar row stays, marked NEW, and opens the
  landing; a corner card rises once (FG4).
- **off**: an admin turned it off, or the workspace cannot have it. Nothing.

The personal workspace borrows: on when a team has it on, offered while one of
the viewer's teams never decided.

## FG3. The landing

`tours/guides/FeatureLanding.tsx`, shown by `TeamFeatureOff` for any feature
with a guide: the feature's name and line, what it gives a team, a chapter of
its guide playing on a loop, Watch the guide, and the switch
(`FeatureSwitches`, the settings action itself).

## FG4. Entry points

The sidebar row (offer), the landing, a once-per-person corner card
(`FeatureOfferAnywhere`, recorded as `offer:<feature>` in the tips bag), the
palette (`ui.guideOrg`, `ui.guideFlows`), Watch the guide beside each switch
in team settings, and the Tours panel.

## FG5. A guide

A guide (`tours/guides/types.ts`) is registered as a tour of `kind: "guide"`
(`tours/registry.ts`, with its length in `minutes`) and defined in
`tours/guides/<feature>Guide.tsx`. It plays one example company, Tidepool,
chapter by chapter on a fixed 1040x600 stage the player scales
(`GuidePlayer`). A chapter is a scene and its beats: the scene draws the stage
for the beat it is given, so stepping back is just a smaller number; a beat
holds and moves on, or asks for a press on the stage (`act`) and waits. Scenes
use the real product pieces where they are pure (`FlowDiagram` draws the
shipped Change flow and a run on it, `RoleAvatar` the role faces) and the
guide kit (`kit.tsx`) for the rest. The last screen is the switch, and Open
starts the page's own spotlight tour (`org-page`, `flows-page`).

A new guide: write the scenes and beats, add the `GuideDef` to
`tours/guides/guides.ts`, register its tour id, and map the feature in
`GUIDE_FOR` (`tours/guides/index.ts`). Check every beat on the stage before
calling it done; `GuidePlayer.mount.test.tsx` covers the player itself.
