import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import * as z from "zod";

/**
 * zod parameters as the JSON Schema pi-durable validates and coerces a call's arguments against.
 *
 * Optional parameters are offered to the model as nullable, and a `null` it sends for one is dropped
 * before validation (chia's `pi/tools.ts` does the same): a model that fills every field otherwise
 * invents a value for one it meant to leave out. A parameter that is itself nullable keeps its
 * `null`. The zod parse that follows applies what JSON Schema cannot express and types the arguments.
 */
export interface ToolJsonSchema {
  /** The schema as written, input side. */
  readonly schema: JsonObject;
  /** What the model is offered: `schema` with optional properties made nullable. */
  readonly offered: JsonObject;
}

export function toolJsonSchema(name: string, parameters: z.ZodType): ToolJsonSchema {
  const json = asObject(z.toJSONSchema(parameters, { io: "input" }));
  if (json?.type !== "object") {
    throw new TypeError(`Tool \`${name}\` must take an object of parameters (z.object(...))`);
  }
  // The provider reads the schema inline; a dialect URI is noise to it.
  const { $schema: _dialect, ...schema } = json;
  return { schema, offered: offerNull(schema) };
}

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;

const asArray = (value: unknown): JsonValue[] | undefined =>
  Array.isArray(value) ? (value as JsonValue[]) : undefined;

const acceptsNull = (schema: JsonObject): boolean => {
  const { type } = schema;
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  const branches = asArray(schema.anyOf) ?? asArray(schema.oneOf);
  return (
    branches?.some((branch) => {
      const object = asObject(branch);
      return object !== undefined && acceptsNull(object);
    }) ?? false
  );
};

const requiredOf = (schema: JsonObject): ReadonlySet<string> =>
  new Set((asArray(schema.required) ?? []).flatMap((key) => (typeof key === "string" ? [key] : [])));

/** Every optional property that rejects `null` is offered as nullable, at any depth. */
function offerNull(schema: JsonObject): JsonObject {
  const next: Record<string, JsonValue> = { ...schema };
  const items = asObject(schema.items);
  if (items) next.items = offerNull(items);
  const properties = asObject(schema.properties);
  if (properties) {
    const required = requiredOf(schema);
    next.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const property = asObject(value);
        if (!property) return [key, value];
        const inner = offerNull(property);
        if (required.has(key) || acceptsNull(inner)) return [key, inner];
        const { description, default: fallback, ...rest } = inner;
        return [
          key,
          {
            anyOf: [rest, { type: "null" }],
            ...(description !== undefined && { description }),
            ...(fallback !== undefined && { default: fallback }),
          },
        ];
      }),
    );
  }
  return next;
}

/** Drops the `null` a model sent for a property `offerNull` made nullable. */
export function omitOfferedNulls(schema: JsonObject, value: unknown): unknown {
  const items = asObject(schema.items);
  const list = asArray(value);
  if (items && list) return list.map((item) => omitOfferedNulls(items, item));
  const properties = asObject(schema.properties);
  const record = asObject(value);
  if (!properties || !record) return value;
  const required = requiredOf(schema);
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const property = asObject(properties[key]);
    if (!property) cleaned[key] = entry;
    else if (entry !== null) cleaned[key] = omitOfferedNulls(property, entry);
    else if (required.has(key) || acceptsNull(property)) cleaned[key] = null;
  }
  return cleaned;
}
