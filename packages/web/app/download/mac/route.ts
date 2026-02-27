import { NextResponse } from "next/server";

const DOWNLOAD_URL = "https://dl.codecast.sh/Codecast-mac-universal.zip";

export async function GET() {
  return NextResponse.redirect(DOWNLOAD_URL, 302);
}
