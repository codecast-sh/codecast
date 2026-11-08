import { describe, expect, test } from "bun:test";
import { THIS_DEVICE } from "@codecast/shared/contracts";
import { defaultDeviceFor } from "./newSessionDefaults";

const now = Date.now();
const studio = { device_id: "studio", user_id: "u", platform: "darwin", last_seen: now, local_project_roots: ["/Users/a/src/littlebird"] };
const laptop = { device_id: "laptop", user_id: "u", platform: "darwin", last_seen: now, local_project_roots: [] };
const box = { device_id: "box", user_id: "u", platform: "linux", last_seen: now, local_project_roots: [] };

function db(ui: any, devices: any[]) {
  const table = (rows: any[]) => ({ withIndex: () => ({ first: async () => rows[0] ?? null, collect: async () => rows }) });
  return { db: { query: (name: string) => table(name === "client_state" ? [{ user_id: "u", ui }] : devices) } };
}

describe("defaultDeviceFor", () => {
  test("the saved machine when it is online and can open the folder", async () => {
    expect(await defaultDeviceFor(db({ default_device: "studio" }, [studio, laptop]), "u" as any, ["/Users/a/src/littlebird"])).toBe("studio");
    expect(await defaultDeviceFor(db({ default_device: "studio" }, [studio, laptop]), "u" as any, [])).toBe("studio");
  });

  test("falls through: no default, This device, offline, removed, wrong platform", async () => {
    expect(await defaultDeviceFor(db({}, [studio]), "u" as any, [])).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: null }, [studio]), "u" as any, [])).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: THIS_DEVICE }, [studio]), "u" as any, [])).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: "studio" }, [{ ...studio, last_seen: now - 10 * 60_000 }]), "u" as any, [])).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: "gone" }, [studio]), "u" as any, [])).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: "box" }, [box]), "u" as any, ["/Users/a/src/littlebird"])).toBeNull();
  });

  test("a trigger needs the checkout itself", async () => {
    expect(await defaultDeviceFor(db({ default_device: "laptop" }, [laptop]), "u" as any, ["/Users/a/src/littlebird"])).toBe("laptop");
    expect(await defaultDeviceFor(db({ default_device: "laptop" }, [laptop]), "u" as any, ["/Users/a/src/littlebird"], { needsCheckout: true })).toBeNull();
    expect(await defaultDeviceFor(db({ default_device: "studio" }, [studio]), "u" as any, ["/Users/a/src/littlebird"], { needsCheckout: true })).toBe("studio");
  });
});
