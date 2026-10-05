// Stripe's request body: application/x-www-form-urlencoded with nested keys in
// brackets (`line_items[0][price]=price_1`, `metadata[user_id]=u1`). Objects
// nest by key, arrays by index, and undefined or null leaves are left out so a
// caller can pass optional fields straight through.

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };
export type FormParams = { [key: string]: FormValue };

function flatten(prefix: string, value: FormValue, out: [string, string][]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(`${prefix}[${index}]`, item, out));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) flatten(prefix ? `${prefix}[${key}]` : key, item, out);
    return;
  }
  out.push([prefix, String(value)]);
}

/** The pairs a params object encodes to, in insertion order. */
export function formPairs(params: FormParams): [string, string][] {
  const out: [string, string][] = [];
  flatten("", params, out);
  return out;
}

/** `params` as a form body (or query string) the way Stripe reads it. */
export function encodeForm(params: FormParams): string {
  return formPairs(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
