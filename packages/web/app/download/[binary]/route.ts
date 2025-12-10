import { NextResponse } from "next/server";

const BINARIES: Record<string, string> = {
  "codecast-darwin-arm64": "https://dl.codecast.sh/codecast-darwin-arm64",
  "codecast-darwin-x64": "https://dl.codecast.sh/codecast-darwin-x64",
  "codecast-linux-arm64": "https://dl.codecast.sh/codecast-linux-arm64",
  "codecast-linux-x64": "https://dl.codecast.sh/codecast-linux-x64",
  "codecast-windows-x64.exe": "https://dl.codecast.sh/codecast-windows-x64.exe",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ binary: string }> }
) {
  const { binary } = await params;

  const url = BINARIES[binary];
  if (!url) {
    return new NextResponse("Binary not found", { status: 404 });
  }

  return NextResponse.redirect(url);
}
