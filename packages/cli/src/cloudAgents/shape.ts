/**
 * The shape of a provider's payload, checked where it is read. A private API
 * (Codex Cloud's wham) can change without notice, and a renamed or retyped
 * field must stop the lane rather than read as "nothing there": a missing
 * task list would look like an account with no tasks, a retyped turn like an
 * empty one. Each shape lists only the fields the adapter reads, and its
 * TypeScript type is inferred from it, so the two can never disagree.
 *
 * A failure names the path (`items[].updated_at`), never a value: payloads
 * carry prompts, code and, in environments, secrets.
 */

/** A payload that is not the shape the adapter reads: the provider changed its API. */
export class CloudShapeError extends Error {
  /** `request`: the call that answered (`GET /tasks/list`); `path`: the field in its body (`items[].updated_at`), "" for the body itself. */
  constructor(readonly path: string, readonly expected: string, readonly got: string, readonly request?: string) {
    super(`${request ? `${request}: ` : ""}${path || "the body"} should be ${expected}, got ${got}`);
  }
}

/** Checks a value at a path and throws CloudShapeError when it does not match. `T` is what the value then is. */
export interface Shape<T> {
  (value: unknown, path: string): void;
  /** Phantom: the checked value's type. */
  readonly _type?: T;
}

export type Infer<S> = S extends Shape<infer T> ? T : never;

function kindOf(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function leaf<T>(expected: string, test: (v: unknown) => boolean): Shape<T> {
  return (value, path) => {
    if (!test(value)) throw new CloudShapeError(path, expected, kindOf(value));
  };
}

export const str: Shape<string> = leaf("a string", (v) => typeof v === "string");
export const num: Shape<number> = leaf("a number", (v) => typeof v === "number" && Number.isFinite(v));
export const bool: Shape<boolean> = leaf("a boolean", (v) => typeof v === "boolean");
/** Anything, read as unknown (a field the adapter passes on without depending on its shape). */
export const unknownValue: Shape<unknown> = () => {};

/**
 * One of a few strings the adapter branches on. A short value that is none
 * of them is named in the error: it is a label the provider added, not data.
 */
export function oneOf<const V extends string>(...values: V[]): Shape<V> {
  const expected = values.map((v) => JSON.stringify(v)).join(" or ");
  return (value, path) => {
    if (typeof value === "string" && (values as string[]).includes(value)) return;
    throw new CloudShapeError(path, expected, typeof value === "string" && value.length <= 40 ? JSON.stringify(value) : kindOf(value));
  };
}

/** May be absent (undefined). */
export function optional<T>(shape: Shape<T>): Shape<T | undefined> {
  return (value, path) => {
    if (value !== undefined) shape(value, path);
  };
}

/** May be absent or null. */
export function maybe<T>(shape: Shape<T>): Shape<T | null | undefined> {
  return (value, path) => {
    if (value !== undefined && value !== null) shape(value, path);
  };
}

export function arrayOf<T>(shape: Shape<T>): Shape<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new CloudShapeError(path, "an array", kindOf(value));
    value.forEach((item) => shape(item, `${path}[]`));
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An object keyed by ids (a task's turn_mapping): every value has the shape. */
export function recordOf<T>(shape: Shape<T>): Shape<Record<string, T>> {
  return (value, path) => {
    if (!isRecord(value)) throw new CloudShapeError(path, "an object", kindOf(value));
    for (const v of Object.values(value)) shape(v, path ? `${path}.*` : "*");
  };
}

type Fields = Record<string, Shape<any>>;
type OptionalKeys<F extends Fields> = { [K in keyof F]: undefined extends Infer<F[K]> ? K : never }[keyof F];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<F extends Fields> = Simplify<{ [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Infer<F[K]> }>;

/** An object with these fields (others are ignored: the provider adds fields freely, and none of them is read). */
export function object<F extends Fields>(fields: F): Shape<ObjectOf<F>> {
  return (value, path) => {
    if (!isRecord(value)) throw new CloudShapeError(path, "an object", kindOf(value));
    for (const [key, shape] of Object.entries(fields)) shape(value[key], path ? `${path}.${key}` : key);
  };
}

/** The value as its shape's type, or CloudShapeError naming where it differs in the answer to `request`. */
export function checkShape<T>(shape: Shape<T>, value: unknown, request: string): T {
  try {
    shape(value, "");
  } catch (err) {
    if (err instanceof CloudShapeError) throw new CloudShapeError(err.path, err.expected, err.got, request);
    throw err;
  }
  return value as T;
}
