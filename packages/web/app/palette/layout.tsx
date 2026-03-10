export default function PaletteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { background: transparent !important; }
      `}} />
      {children}
    </>
  );
}
