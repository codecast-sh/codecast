// Where and how a person's new sessions start, when they say so. The values
// live in client_state.ui (stamped keys, so they follow the person to every
// device) and every starter reads them: the web and phone composers, `cast
// spawn` and spawning triggers.
//
//   default_device   absent = the last hand pick · THIS_DEVICE · a device_id
//   default_agent    absent = the last hand pick · a Convex agent_type
//   default_project  absent = where you are working · a project path
//
// A default that cannot serve right now (machine offline, folder on no
// machine of yours) falls through to the next rung; it never blocks a start.

/** default_device's value for "the machine this client runs on". */
export const THIS_DEVICE = "this_device";

export type NewSessionDefaults = {
  default_device?: string | null;
  default_agent?: string | null;
  default_project?: string | null;
};
