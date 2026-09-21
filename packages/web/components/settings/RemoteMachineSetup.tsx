import { useState } from "react";
import { Cloud, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { copyToClipboard } from "../../lib/utils";
import { remoteMachineSetupCommand, type RemoteMachineSetup as SetupForm } from "../../lib/remoteMachineSetup";

export function RemoteMachineSetup({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState<SetupForm>({ platform: "linux", mode: "existing", instance: "", region: "us-west-2", profile: "", key: "", name: "", image: "", keyName: "", subnet: "", securityGroup: "", dedicatedHost: "" });
  const command = remoteMachineSetupCommand(form);
  const field = (key: keyof SetupForm, label: string, placeholder: string) => (
    <label className="grid gap-1.5 text-xs text-sol-text-muted" key={key}>
      {label}
      <Input value={form[key] ?? ""} placeholder={placeholder} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className="h-8 font-mono text-xs" autoComplete="off" spellCheck={false} />
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-sol-border bg-sol-card sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Cloud className="h-4 w-4 text-sol-cyan" />Add a cloud machine</DialogTitle>
          <DialogDescription>Set up a machine in your AWS account. Your laptop connects it to Codecast and copies your agent configuration.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2" aria-label="Operating system">
          {(["linux", "mac"] as const).map((platform) => (
            <button key={platform} type="button" aria-pressed={form.platform === platform}
              onClick={() => setForm({ ...form, platform, instanceType: "", region: platform === "mac" ? "us-east-2" : "us-west-2" })}
              className={`rounded-md border p-3 text-left ${form.platform === platform ? "border-sol-cyan bg-sol-cyan/5" : "border-sol-border hover:bg-sol-bg-alt"}`}>
              <span className="block text-sm font-medium text-sol-text">{platform === "linux" ? "Linux" : "Mac"}</span>
              <span className="mt-1 block text-xs text-sol-text-muted">{platform === "linux" ? "General development. Sleeps when idle." : "Xcode, iOS, and macOS development."}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-sol-text-muted">
          {form.platform === "linux" ? "Compute is billed while running. Disk storage remains billed while stopped." : "AWS Macs need a dedicated host with a 24-hour minimum charge. Stopping the Mac does not release that host."}
        </p>
        <div className="flex gap-2" aria-label="Machine source">
          {(["existing", "new"] as const).map((mode) => <Button key={mode} type="button" size="sm" variant={form.mode === mode ? "secondary" : "ghost"} aria-pressed={form.mode === mode} onClick={() => setForm({ ...form, mode })}>{mode === "existing" ? "Connect existing" : "Create new"}</Button>)}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {form.mode === "existing" ? field("instance", "EC2 instance ID", "i-…") : <>
            {field("name", "Machine name", form.platform === "mac" ? "dev-mac" : "dev-linux")}
            {field("image", form.platform === "mac" ? "macOS AMI ID" : "Ubuntu 24.04 x86_64 AMI ID", "ami-…")}
            {field("keyName", "AWS key pair name", "dev-key")}
            {field("subnet", "Public subnet ID", "subnet-…")}
            {field("securityGroup", "SSH security group ID", "sg-…")}
            {field("instanceType", "Instance type (optional)", form.platform === "mac" ? "mac2.metal" : "t3.medium")}
            {form.platform === "mac" && field("dedicatedHost", "Matching dedicated host ID", "h-…")}
          </>}
          {field("region", "AWS region", "us-west-2")}
          {field("key", "SSH private key path on your laptop", "~/.ssh/dev-key.pem")}
          {field("profile", "AWS profile (optional)", "default")}
          {form.platform === "mac" && form.mode === "existing" && field("serviceUser", "Separate Mac login (optional)", "codecast")}
        </div>
        {form.platform === "mac" && form.mode === "existing" && <p className="text-xs text-sol-text-muted">A separate login keeps other agents and their dotfiles intact. Setup gives this login SSH access and passwordless sudo.</p>}
        <div className="space-y-2 rounded-md border border-sol-border bg-sol-bg-alt p-3">
          <p className="text-xs font-medium text-sol-text">Run from your project on your laptop</p>
          <p className="text-xs text-sol-text-muted">Requires the AWS CLI signed in and SSH access. Setup installs tools, syncs configuration, and waits for the machine to come online.</p>
          {command ? <code className="block break-all text-xs text-sol-text-secondary select-all">{command}</code> : <p className="text-xs text-sol-text-dim">Fill in the machine details to build the setup command.</p>}
          <Button type="button" size="sm" variant="outline" disabled={!command} onClick={() => { if (command) void copyToClipboard(command).then(() => toast.success("Setup command copied")); }}><Copy className="mr-1.5 h-3 w-3" />Copy setup command</Button>
        </div>
        <p className="text-xs text-sol-text-muted">When setup finishes, choose the machine in a new session. Setup can be rerun after a failure; existing workspaces are kept.</p>
      </DialogContent>
    </Dialog>
  );
}
