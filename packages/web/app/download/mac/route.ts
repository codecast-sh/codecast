import { NextResponse } from "next/server";

const DOWNLOAD_BASE = "https://dl.codecast.sh/Codecast-1.1.4-arm64.dmg";
const VERSION = "1.1.4";

export async function GET() {
  return NextResponse.redirect(`${DOWNLOAD_BASE}?v=${VERSION}`, 302);
}
