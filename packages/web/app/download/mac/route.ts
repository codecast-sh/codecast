import { NextResponse } from "next/server";

const DOWNLOAD_BASE = "https://dl.codecast.sh/Codecast-mac-arm64.zip";
const VERSION = "0.1.1";

export async function GET() {
  return NextResponse.redirect(`${DOWNLOAD_BASE}?v=${VERSION}`, 302);
}
