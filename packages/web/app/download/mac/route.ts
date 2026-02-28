import { NextResponse } from "next/server";

const DOWNLOAD_BASE = "https://dl.codecast.sh/Codecast-0.1.2-arm64.dmg";
const VERSION = "0.1.2";

export async function GET() {
  return NextResponse.redirect(`${DOWNLOAD_BASE}?v=${VERSION}`, 302);
}
