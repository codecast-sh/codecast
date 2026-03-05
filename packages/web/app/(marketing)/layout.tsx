import { ForceLightMode } from "@/components/force-light-mode";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ForceLightMode />
      <div className="light min-h-screen w-full fixed inset-0 overflow-auto" style={{ backgroundColor: '#fdf6e3' }}>
        {children}
      </div>
    </>
  );
}
