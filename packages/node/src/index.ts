import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeSqliteStorageOptions } from "@earendil-works/pi-durable/storage/sqlite/node";

import { assertScope, inProcessLeases } from "@chia1104/motoko-core";
import type { AgentHost, AgentStore, Lease, StorageScope } from "@chia1104/motoko-core";

import { eraseSqliteConversations } from "./erase.ts";

export { eraseSqliteConversations } from "./erase.ts";
export { FORWARDED_BY } from "./forward.ts";
export type { ClusterOptions } from "./forward.ts";
export { motokoHandler } from "./http.ts";
export type { FollowCall, HttpCall, MotokoHandlerOptions, MotokoTarget } from "./http.ts";
export { nodeListener } from "./listener.ts";
export type { FetchHandler, NodeListenerOptions } from "./listener.ts";

/** Opens one scope's pi-durable storage. `lease` is the lease held for this open. */
export type StorageFactory = (scope: StorageScope, lease: Lease) => Promise<Storage>;

/** Acquires one scope's single-writer lease. Rejects with `LeaseHeldError` while the lease is held. */
export type LeaseProvider = (scope: StorageScope) => Promise<Lease>;

/**
 * A store as `nodeHost` takes it. It is an `AgentStore`, or a storage alone that takes any lease and gets
 * `processLeases`. `L` is the store's own lease, and only that lease reaches its storage and `erase`. A storage that
 * takes a narrower lease than `Lease` comes with the `lease` that makes it.
 */
export type NodeStore<L extends Lease = Lease> = {
  readonly storage: (scope: StorageScope, lease: NoInfer<L>) => Promise<Storage>;
  /** The scopes that may have unfinished work, for `runtime.recover()`. See `AgentStore.unfinished`. */
  readonly unfinished?: () => AsyncIterable<StorageScope>;
  /** Erases deleted sessions from a scope's storage. See `AgentStore.erase`. */
  readonly erase?: (scope: StorageScope, lease: NoInfer<L>, conversations: readonly ConversationId[]) => Promise<void>;
} & (Lease extends L
  ? {
      /** Default: `processLeases`, shared by every host of this process. */
      readonly lease?: (scope: StorageScope) => Promise<L>;
    }
  : { readonly lease: (scope: StorageScope) => Promise<L> });

/**
 * The leases every `nodeHost` of this process shares by default, so two runtimes in one process never
 * both write a scope, whatever storage each was given. They are `@chia1104/motoko-core`'s in-process leases,
 * so they do not cover other processes.
 */
export const processLeases: LeaseProvider = inProcessLeases();

/**
 * The host of a long-lived process, such as an Electron backend or a Node server, on `store`. It calls each of the
 * store's members as a method of `store`. pi-durable's own timers wake sleeping work, and the runtime carries on
 * unfinished work when it opens an instance.
 */
export function nodeHost<L extends Lease>(store: NodeStore<L>): AgentHost {
  return {
    wake: { kind: "process" },
    lease: store.lease?.bind(store) ?? processLeases,
    storage: store.storage.bind(store),
    ...(store.unfinished !== undefined && { unfinished: store.unfinished.bind(store) }),
    ...(store.erase !== undefined && { erase: store.erase.bind(store) }),
  };
}

export type SqliteStorageOptions = (
  | {
      /**
       * One SQLite file per scope, at `<directory>/<kind>/<name>.sqlite`. `scopeFileSegment` encodes each
       * segment, so any string is a safe, distinct file name.
       */
      readonly directory: string;
    }
  | {
      /** The file of a scope, for a layout of the host's own. Two scopes must never share a file. */
      readonly path: (scope: StorageScope) => string;
    }
) & {
  /** Passed to pi-durable's `openNodeSqliteStorage`, such as a table `prefix`. */
  readonly sqlite?: NodeSqliteStorageOptions;
};

const SAFE = /[a-z0-9_-]/;
const MAX_SEGMENT = 120;

/**
 * A scope's kind or name as one file name segment. Lowercase letters, digits, `_` and `-` are kept, and
 * every other UTF-8 byte is written `%XX`. Uppercase letters are encoded too, so the mapping stays
 * one-to-one on case-insensitive file systems such as those of macOS and Windows. A segment longer than
 * 120 characters keeps its first 80 and a SHA-256 digest of the whole value.
 */
export function scopeFileSegment(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += byte < 0x80 && SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (encoded.length <= MAX_SEGMENT) return encoded;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${encoded.slice(0, 80)}~${digest}`;
}

const SQLITE = ".sqlite";
const DIGEST_SCOPE_SIDE_FILE = ".scope.json";

/** The file `sqliteStorage({ directory })` keeps a scope in. */
export function scopeFile(directory: string, scope: StorageScope): string {
  assertScope(scope);
  return join(directory, scopeFileSegment(scope.kind), `${scopeFileSegment(scope.name)}${SQLITE}`);
}

function segmentValue(segment: string): string | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "%") {
      const hex = segment.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else if (SAFE.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else {
      return undefined;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function holdsDigest(file: string): boolean {
  return segmentValue(basename(dirname(file))) === undefined || segmentValue(basename(file, SQLITE)) === undefined;
}

async function scopeOfFile(directory: string, file: string): Promise<StorageScope | undefined> {
  const kind = segmentValue(basename(dirname(file)));
  const name = segmentValue(basename(file, SQLITE));
  let scope: StorageScope | undefined = kind !== undefined && name !== undefined ? { kind, name } : undefined;
  if (scope === undefined) {
    try {
      const noted = JSON.parse(
        await readFile(`${file.slice(0, -SQLITE.length)}${DIGEST_SCOPE_SIDE_FILE}`, "utf8"),
      ) as unknown;
      if (typeof noted === "object" && noted !== null && "kind" in noted && "name" in noted) {
        scope = { kind: noted.kind as string, name: noted.name as string };
      }
    } catch {
      return undefined;
    }
  }
  try {
    return scope !== undefined && scopeFile(directory, scope) === file ? scope : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every scope `sqliteStorage({ directory })` keeps a file for, each once. They are a superset of the scopes with
 * unfinished work, and `runtime.recover()` opens them all, since a SQLite file records no more. For a file whose name
 * holds a digest, the scope comes from the side file `sqliteStorage` writes beside it. Files of other layouts are
 * skipped.
 */
export async function* sqliteScopes(directory: string): AsyncGenerator<StorageScope, void, undefined> {
  let kinds;
  try {
    kinds = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const kind of kinds) {
    if (!kind.isDirectory()) continue;
    for (const entry of await readdir(join(directory, kind.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(SQLITE)) continue;
      const scope = await scopeOfFile(directory, join(directory, kind.name, entry.name));
      if (scope !== undefined) yield scope;
    }
  }
}

function fileOf(options: SqliteStorageOptions): (scope: StorageScope) => string {
  return "directory" in options ? (scope) => scopeFile(options.directory, scope) : options.path;
}

/**
 * pi-durable's SQLite storage on Node's built-in `node:sqlite`, one database file per scope. pi's
 * SQLite store runs in WAL mode, so commits survive a process crash. SQLite's file locks do not make
 * two writers safe. The lease does, within its reach.
 */
export function sqliteStorage(options: SqliteStorageOptions): StorageFactory {
  const fileFor = fileOf(options);
  return async (scope) => {
    const file = fileFor(scope);
    await mkdir(dirname(file), { recursive: true });
    if ("directory" in options && holdsDigest(file)) {
      await writeFile(`${file.slice(0, -SQLITE.length)}${DIGEST_SCOPE_SIDE_FILE}`, JSON.stringify(scope), {
        flag: "wx",
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    return openNodeSqliteStorage(file, options.sqlite);
  };
}

/**
 * The complete store on SQLite files. Its storage is `sqliteStorage(options)` under `options.lease`, which defaults to
 * `processLeases`. It erases deleted sessions from their files with `eraseSqliteConversations`. With `directory`, it
 * gives `runtime.recover()` every scope it keeps a file for, through `sqliteScopes`. `nodeHost(sqliteStore(options))`
 * is its host.
 */
export function sqliteStore(options: SqliteStorageOptions & { readonly lease?: LeaseProvider }): AgentStore {
  const fileFor = fileOf(options);
  const prefix = options.sqlite?.prefix;
  return {
    lease: options.lease ?? processLeases,
    storage: sqliteStorage(options),
    ...("directory" in options && { unfinished: () => sqliteScopes(options.directory) }),
    erase: (scope, _lease, conversations) =>
      eraseSqliteConversations(fileFor(scope), conversations, { ...(prefix !== undefined && { prefix }) }),
  };
}
