import { ForceLightMode } from "@/components/force-light-mode";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ForceLightMode />
      <div className="light min-h-screen bg-stone-50 w-full fixed inset-0 overflow-auto">
        {children}
      </div>
    </>
  );
}
