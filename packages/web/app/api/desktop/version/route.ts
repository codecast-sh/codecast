import { NextResponse } from "next/server";

const LATEST_VERSION = "1.1.3";
const DOWNLOAD_URL = "https://codecast.sh/download/mac";

export async function GET() {
  return NextResponse.json({
    version: LATEST_VERSION,
    downloadUrl: DOWNLOAD_URL,
  });
}
