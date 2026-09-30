// The host step of a hire from a template, run by a daemon for the web
// (docs/architecture/org-hire.md H3, H4). One shape from the mutation that
// enqueues the `org_template_bind` command to the daemon that executes it.
import type { EncryptedProviderKeyPayload } from "./providerKeyCrypto";

/** A secret input's value, sealed in the browser to the target device's
 *  provider-key public key. `payload.provider` carries the input's key. */
export type OrgTemplateBindSecret = { key: string; payload: EncryptedProviderKeyPayload };

export type OrgTemplateBindArgs = {
  instance_key: string;
  instance: string;
  /** The project checkout on the target device: the standing session's directory. */
  dir: string;
  workspace: { kind: "team" | "user"; id: string };
  secrets: OrgTemplateBindSecret[];
};

export type OrgTemplateBindResult = {
  instance: string;
  phase: string;
  /** The secret inputs bound in this run. */
  bound: string[];
  host?: string;
};

/** Where the daemon keeps a secret it received for an instance: one 0600 file per input under a 0700 directory in the codecast config dir. */
export const ORG_TEMPLATE_SECRETS_DIR = "org-template-secrets";
