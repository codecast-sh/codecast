import { startSamplingProfiler, samplingProfilerStackTraces } from "bun:jsc";
import { afterAll } from "bun:test";
startSamplingProfiler();
afterAll(() => { const t = samplingProfilerStackTraces(); require("fs").writeFileSync(process.env.PROF_OUT ?? "/tmp/u14cp/out.txt", typeof t === "string" ? t : JSON.stringify(t)); });
