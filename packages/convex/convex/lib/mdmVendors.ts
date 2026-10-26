// The MDMs an admin can download a configuration profile for, and the variable
// each one substitutes with the device user's email (the profile's UserEmail).
// Pure data: Team settings > Managed devices lists them, and
// managedDevices.buildEnrollmentProfile fills the profile from the chosen one.
export const MDM_VENDORS = [
  { id: "jamf_kandji", name: "Jamf / Kandji", email_variable: "$EMAIL" },
  { id: "intune", name: "Intune", email_variable: "{{mail}}" },
  { id: "mosyle", name: "Mosyle", email_variable: "%Email%" },
] as const;

export type MdmVendorId = (typeof MDM_VENDORS)[number]["id"];

export const DEFAULT_MDM_VENDOR: MdmVendorId = "jamf_kandji";

export function mdmEmailVariable(id: string | undefined): string {
  return (MDM_VENDORS.find((m) => m.id === id) ?? MDM_VENDORS[0]).email_variable;
}
