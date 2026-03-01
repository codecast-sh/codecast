import { NextResponse } from "next/server";

const DOWNLOAD_BASE = "https://dl.codecast.sh/Codecast-1.1.3-arm64.dmg";
const VERSION = "1.1.3";

export async function GET() {
  return NextResponse.redirect(`${DOWNLOAD_BASE}?v=${VERSION}`, 302);
}
