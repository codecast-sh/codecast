import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

const ALLOWED_BINARIES = [
  "codecast-darwin-arm64",
  "codecast-darwin-x64",
  "codecast-linux-arm64",
  "codecast-linux-x64",
  "codecast-windows-x64.exe",
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ binary: string }> }
) {
  const { binary } = await params;

  if (binary === "debug") {
    const cwd = process.cwd();
    const binariesPath = join(cwd, "binaries");
    let files: string[] = [];
    try {
      files = await readdir(binariesPath);
    } catch {
      files = ["directory not found"];
    }
    return NextResponse.json({ cwd, binariesPath, files });
  }

  if (!ALLOWED_BINARIES.includes(binary)) {
    return new NextResponse("Binary not found", { status: 404 });
  }

  try {
    const binaryPath = join(process.cwd(), "binaries", binary);
    const binaryData = await readFile(binaryPath);

    return new NextResponse(binaryData, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${binary}"`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    return new NextResponse("Binary not found", { status: 404 });
  }
}
