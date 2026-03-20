import { NextResponse } from "next/server";
import pkg from "../../../package.json";

export function GET() {
  return NextResponse.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: pkg.version,
  });
}
