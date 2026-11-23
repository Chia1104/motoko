// How Durable's records map to columns, for every SQL dialect. Ported from pi-durable 1.6.0 `storage/sqlite/rows.js`.
//
// Records are stored as JSON text. `JSON.stringify` escapes lone surrogates, so the text is well-formed UTF-8 that any
// text column accepts and returns byte for byte.

import type { DocumentAddress, DocumentRecord, Id, Seq } from "@earendil-works/pi-durable";

export const parseJson = <T>(value: string): T => JSON.parse(value) as T;
export const encodeJson = (value: unknown): string => JSON.stringify(value);
/** Indexed string columns hold the JSON encoding of the string, so lone surrogates survive the UTF-8 round trip. */
export const encodeIndexedString = (value: string): string => JSON.stringify(value);

/**
 * Drivers return a 64-bit integer as `string`, `number` or `bigint`. Every stored integer is at most 2^53: IDs are
 * safe integers, and a scope's `next_id` reaches 2^53 once `Number.MAX_SAFE_INTEGER` is stored.
 */
export function toNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || Math.abs(number) > 2 ** 53) {
    throw new Error(`Expected an integer of at most 2^53 from the database, got ${String(value)}`);
  }
  return number;
}

export const idFromNumber = <I extends Id<string>>(value: number): I => value as I;
export const seqFromNumber = (value: number): Seq => value as Seq;

export type ScopeKind = "session" | "conversation" | "task";

export const scopeColumns = (scope: DocumentRecord["scope"]): { scopeKind: ScopeKind; ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
};

/** A document address as its columns hold it. */
export interface AddressParts {
  readonly kind: string;
  readonly scopeKind: ScopeKind;
  readonly ownerId: number;
  readonly family: 0 | 1;
  readonly keyValue: string;
}

export const addressParts = (address: DocumentAddress | DocumentRecord): AddressParts => {
  const scope = scopeColumns(address.scope);
  return {
    kind: encodeIndexedString(address.kind),
    ...scope,
    family: address.key === undefined ? 0 : 1,
    keyValue: encodeIndexedString(address.key ?? ""),
  };
};

/** A stable string for an address's columns, for maps. */
export const partsKey = (parts: AddressParts): string =>
  JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);

export const addressKey = (address: DocumentAddress | DocumentRecord): string => partsKey(addressParts(address));

/** Whether a document keeps only its current state: its revisions go at each new base and at retirement. */
export const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";
