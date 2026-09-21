export type RemoteMachineSetup = {
  platform: "linux" | "mac";
  mode: "existing" | "new";
  instance: string;
  region: string;
  profile: string;
  key: string;
  name: string;
  image: string;
  keyName: string;
  subnet: string;
  securityGroup: string;
  dedicatedHost: string;
  serviceUser?: string;
  instanceType?: string;
};

const quote = (value: string) => `'${value.trim().replace(/'/g, `'"'"'`)}'`;

export function remoteMachineSetupCommand(form: RemoteMachineSetup): string | null {
  const required = form.mode === "existing" ? [form.instance, form.region, form.key]
    : [form.name, form.image, form.keyName, form.subnet, form.securityGroup, form.region, form.key, ...(form.platform === "mac" ? [form.dedicatedHost] : [])];
  if (required.some((value) => !value.trim()) || Object.values(form).some((value) => /[\r\n\0]/.test(value ?? ""))) return null;
  const args = form.mode === "existing" ? ["cast hosts add", quote(form.instance), "--provision"]
    : ["cast hosts create", form.platform, "--name", quote(form.name), "--image", quote(form.image),
      "--key-name", quote(form.keyName), "--subnet", quote(form.subnet), "--security-group", quote(form.securityGroup),
      ...(form.platform === "mac" ? ["--dedicated-host", quote(form.dedicatedHost)] : [])];
  args.push("--region", quote(form.region), "--key", quote(form.key));
  if (form.profile.trim()) args.push("--profile", quote(form.profile));
  if (form.mode === "existing" && form.platform === "mac" && form.serviceUser?.trim()) args.push("--service-user", quote(form.serviceUser));
  if (form.mode === "new" && form.instanceType?.trim()) args.push("--type", quote(form.instanceType));
  return args.join(" ");
}
