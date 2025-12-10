import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const installScript = await readFile(
      join(process.cwd(), "public", "install.ps1"),
      "utf-8"
    );

    return new NextResponse(installScript, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    return new NextResponse("Install script not found", { status: 404 });
  }
}
