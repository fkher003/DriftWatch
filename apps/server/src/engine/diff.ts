import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import type { Change, Failure } from "@driftwatch/contracts";

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (v: unknown) =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
function child(path: string, key: string, array = false) {
  if (array) return path + "[" + key + "]";
  return /^[a-zA-Z_$][\w$]*$/.test(key)
    ? path + "." + key
    : path + "[" + JSON.stringify(key) + "]";
}
function location(pointer: string, body: unknown) {
  let path = "$",
    value = body;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    path = child(path, key, Array.isArray(value));
    value =
      object(value) || Array.isArray(value)
        ? (value as Schema)[key]
        : undefined;
  }
  return { path, value };
}
const validators = new Map<string, ValidateFunction>();
export function compileSchema(schema: Schema) {
  if (schema.$async) throw Error("Async schemas are unsupported");
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  const validate = new Ajv({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    ownProperties: true,
    verbose: true,
  }).compile(schema);
  if (validators.size >= 128)
    validators.delete(validators.keys().next().value!);
  validators.set(key, validate);
  return validate;
}
function problem(error: ErrorObject, body: unknown): Change {
  let { path, value } = location(error.instancePath, body);
  if (error.keyword === "required")
    return {
      path: child(path, error.params.missingProperty),
      classification: "BREAKING",
      expected: "required property",
      actual: "missing",
    };
  if (error.keyword === "additionalProperties") {
    const key = error.params.additionalProperty;
    return {
      path: child(path, key),
      classification: "BREAKING",
      expected: "no additional property",
      actual: describe((value as Schema)[key]),
    };
  }
  const typeMismatch = error.keyword === "type";
  const actual =
    typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : describe(value);
  return {
    path,
    classification: "BREAKING",
    expected: typeMismatch
      ? String(error.params.type)
      : (error.message ?? error.keyword),
    actual: typeMismatch ? describe(value) : actual,
  };
}
export function inspect(schema: Schema, body: unknown): Change[] {
  const validate = compileSchema(schema);
  validate(body);
  const changes = (validate.errors ?? []).map((error) => problem(error, body));
  function additions(rule: unknown, value: unknown, path: string) {
    if (!object(rule)) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) =>
        additions(
          Array.isArray(rule.items) ? rule.items[i] : rule.items,
          item,
          child(path, String(i), true),
        ),
      );
      return;
    }
    if (!object(value) || !object(rule.properties)) return;
    for (const [key, member] of Object.entries(value)) {
      const next = child(path, key);
      if (Object.hasOwn(rule.properties, key))
        additions(rule.properties[key], member, next);
      else if (
        rule.additionalProperties !== false &&
        !rule.patternProperties &&
        !object(rule.additionalProperties)
      )
        changes.push({
          path: next,
          classification: "WARNING",
          expected: "undeclared property",
          actual: describe(member),
        });
    }
  }
  additions(schema, body, "$");
  return changes;
}
export function fingerprint(
  changes: readonly { classification: Failure; path: string }[],
) {
  if (!changes.length) return null;
  const keys = [
    ...new Set(changes.map((c) => JSON.stringify([c.classification, c.path]))),
  ].sort();
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}
