// Argument validation for the multiplayer sim backend (simBackend.testing.ts).
//
// Convex validates a call's arguments in its backend, not in the JS package, so
// a fake db driven through `fn._handler` skips that check entirely: a client
// that sends a stub id, a misspelled field, or a flag an older server lacks
// passes in a test and fails in prod. This walks the JSON validator a
// registered function exports (`fn.exportArgs()`) and throws with the message
// shape prod uses, so code that matches on it (the web dispatch's
// `ack_positions` fallback) behaves the same against the sim.
//
// Two dots in the name keep the Convex bundler from treating this file as a
// function module. It imports nothing from bun:test, so `cast check convex`
// covers it.
import { convexToJson, jsonToConvex } from "convex/values";

// The JSON form of a validator, as `Validator.json` produces it.
export type ValidatorJson =
  | { type: "any" | "string" | "number" | "bigint" | "boolean" | "null" | "bytes" }
  | { type: "id"; tableName: string }
  | { type: "literal"; value: unknown }
  | { type: "array"; value: ValidatorJson }
  | { type: "union"; value: ValidatorJson[] }
  | { type: "object"; value: Record<string, { fieldType: ValidatorJson; optional: boolean }> }
  | { type: "record"; keys: ValidatorJson; values: { fieldType: ValidatorJson; optional: boolean } };

export interface ValidateOptions {
  // Whether `value` is a valid id of `table`. Prod decodes the table from the
  // id itself; the sim asks its db. Without it any string passes.
  isId?: (table: string, value: string) => boolean;
}

export class ArgumentValidationError extends Error {
  constructor(detail: string) {
    super(`ArgumentValidationError: ${detail}`);
    this.name = "ArgumentValidationError";
  }
}

// Validate `args` against a registered function's exported args validator
// (the string `fn.exportArgs()` returns, or its parsed form).
export function validateArgs(validator: string | ValidatorJson, args: unknown, opts: ValidateOptions = {}): void {
  const json: ValidatorJson = typeof validator === "string" ? JSON.parse(validator) : validator;
  const failure = check(json, args, "", opts);
  if (failure) throw new ArgumentValidationError(failure);
}

// The first mismatch as prod words it, or null when the value conforms.
function check(validator: ValidatorJson, value: unknown, path: string, opts: ValidateOptions): string | null {
  const noMatch = () =>
    `Value does not match validator.\nPath: ${path || "."}\nValue: ${display(value)}\nValidator: ${render(validator)}`;
  switch (validator.type) {
    case "any":
      return null;
    case "string":
      return typeof value === "string" ? null : noMatch();
    case "number":
      return typeof value === "number" ? null : noMatch();
    case "bigint":
      return typeof value === "bigint" ? null : noMatch();
    case "boolean":
      return typeof value === "boolean" ? null : noMatch();
    case "null":
      return value === null ? null : noMatch();
    case "bytes":
      return value instanceof ArrayBuffer ? null : noMatch();
    case "id":
      if (typeof value !== "string") return noMatch();
      if (opts.isId && !opts.isId(validator.tableName, value)) {
        return `Value does not match validator.\nPath: ${path || "."}\nValue: ${display(value)}\nValidator: ${render(validator)}\n`
          + `Unable to decode ID: not an id of table "${validator.tableName}"`;
      }
      return null;
    case "literal":
      return jsonToConvex(validator.value as any) === value ? null : noMatch();
    case "array": {
      if (!Array.isArray(value)) return noMatch();
      for (let i = 0; i < value.length; i++) {
        const inner = check(validator.value, value[i], `${path}[${i}]`, opts);
        if (inner) return inner;
      }
      return null;
    }
    case "union":
      return validator.value.some((member) => check(member, value, path, opts) === null) ? null : noMatch();
    case "object": {
      if (!isPlainObject(value)) return noMatch();
      const where = path ? `Path: ${path}\n` : "";
      for (const [field, spec] of Object.entries(validator.value)) {
        const fieldValue = (value as Record<string, unknown>)[field];
        if (fieldValue === undefined) {
          if (spec.optional) continue;
          return `Object is missing the required field \`${field}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.\n\n`
            + `${where}Object: ${display(value)}\nValidator: ${render(validator)}`;
        }
        const inner = check(spec.fieldType, fieldValue, `${path}.${field}`, opts);
        if (inner) return inner;
      }
      for (const field of Object.keys(value as object)) {
        if (!(field in validator.value) && (value as Record<string, unknown>)[field] !== undefined) {
          return `Object contains extra field \`${field}\` that is not in the validator.\n\n`
            + `${where}Object: ${display(value)}\nValidator: ${render(validator)}`;
        }
      }
      return null;
    }
    case "record": {
      if (!isPlainObject(value)) return noMatch();
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const badKey = check(validator.keys, key, `${path}.${key}`, opts);
        if (badKey) return badKey;
        if (inner === undefined && validator.values.optional) continue;
        const badValue = check(validator.values.fieldType, inner, `${path}.${key}`, opts);
        if (badValue) return badValue;
      }
      return null;
    }
  }
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function display(value: unknown): string {
  try {
    return JSON.stringify(convexToJson(value as any));
  } catch {
    return String(value);
  }
}

// A validator in the `v.` notation prod prints.
export function render(validator: ValidatorJson): string {
  switch (validator.type) {
    case "any":
    case "string":
    case "boolean":
    case "null":
    case "bytes":
      return `v.${validator.type}()`;
    case "number":
      return "v.float64()";
    case "bigint":
      return "v.int64()";
    case "id":
      return `v.id("${validator.tableName}")`;
    case "literal":
      return `v.literal(${JSON.stringify(validator.value)})`;
    case "array":
      return `v.array(${render(validator.value)})`;
    case "union":
      return `v.union(${validator.value.map(render).join(", ")})`;
    case "object":
      return `v.object({${Object.entries(validator.value)
        .map(([field, spec]) => `${field}: ${spec.optional ? `v.optional(${render(spec.fieldType)})` : render(spec.fieldType)}`)
        .join(", ")}})`;
    case "record":
      return `v.record(${render(validator.keys)}, ${render(validator.values.fieldType)})`;
  }
}
