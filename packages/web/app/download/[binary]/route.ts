import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

const ALLOWED_BINARIES = ["codecast-darwin-arm64"];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ binary: string }> }
) {
  const { binary } = await params;

  if (!ALLOWED_BINARIES.includes(binary)) {
    return new NextResponse("Binary not found", { status: 404 });
  }

  try {
    const binaryPath = join(process.cwd(), "public", "binaries", binary);
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
