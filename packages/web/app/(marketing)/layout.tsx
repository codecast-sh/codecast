import { ForceLightMode } from "@/components/force-light-mode";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ForceLightMode />
      <div className="light min-h-screen bg-[#f5f5f0] w-full fixed inset-0 overflow-auto">
        {children}
      </div>
    </>
  );
}
