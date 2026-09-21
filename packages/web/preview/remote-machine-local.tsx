import "../app/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { RemoteMachineSetup } from "../components/settings/RemoteMachineSetup";

document.documentElement.classList.add("dark");
function Preview() {
  const [open, setOpen] = useState(true);
  return <div className="min-h-screen bg-sol-bg text-sol-text p-8"><button onClick={() => setOpen(true)}>Add a cloud machine</button><RemoteMachineSetup open={open} onOpenChange={setOpen} /><Toaster /></div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
