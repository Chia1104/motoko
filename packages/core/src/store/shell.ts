// What every storage of a shared-database store does around its statements, whatever its dialect: it admits calls
// until `close()` and drains them, mints IDs in memory, runs a commit through `commitBatches`, retries a read on a
// transient connection failure, and keeps what `findDocument` read for the `document()` call that follows it. The
// dialect's storage writes the statements and hands them to this shell.

import { apply } from "@earendil-works/chord/delta";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type {
  CommitResult,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentRecord,
  Id,
  JsonObject,
  Seq,
  StorageWrite,
  StoredDocument,
} from "@earendil-works/pi-durable";

import { commitBatches } from "./commit.ts";
import type { CommitPort } from "./commit.ts";
import type { FencedLease } from "./lease.ts";
import { retry } from "./retry.ts";
import { addressKey, idFromNumber, isCurrentOnly, parseJson } from "./rows.ts";

/** A document's stored rows at one point, read in one snapshot: its record, and what its content there is built from. */
export interface DocumentRows {
  /** The document's record as JSON text; `undefined`: no such document. */
  readonly record: string | undefined;
  /** The newest base revision at or before the point; `undefined`: none. */
  readonly base: { readonly version: number; readonly content: string } | undefined;
  /** The revisions after the base, up to the point, in seq order. */
  readonly tail: readonly { readonly kind: string; readonly version: number; readonly content: string }[];
}

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === "current") return record.retiredAt === undefined;
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

/** Document `id`'s content at `at` from its stored rows: the base with the deltas after it applied. */
export function materializeDocument(rows: DocumentRows, id: number, at: DocumentPoint): StoredDocument | undefined {
  if (rows.record === undefined) return undefined;
  const record = parseJson<DocumentRecord>(rows.record);
  if (at !== "current" && isCurrentOnly(record)) {
    throw new StorageRequestError(`Document ${id} does not retain historical content`);
  }
  if (!isAliveAt(record, at)) return undefined;
  const { base, tail } = rows;
  if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
  let value = parseJson<JsonObject>(base.content);
  for (const revision of tail) {
    if (revision.kind !== "delta" || revision.version !== base.version) {
      throw new Error(`Document ${id} crosses a stored version boundary without a base`);
    }
    value = apply(value, parseJson(revision.content));
  }
  return { record, version: base.version, value, deltasSinceBase: tail.length };
}

export interface StorageShellOptions {
  /** The storage's class name, as the error of a call after `close()` names it. */
  readonly name: string;
  /** The lease that fences every commit. */
  readonly lease: FencedLease;
  /** Attempts of a read or a commit's statement on a transient connection failure. */
  readonly attempts: number;
  /** The storage's commit statements. */
  readonly port: CommitPort;
  /** The scope's `next_id`, as the storage's open read it. */
  readonly nextId: number;
}

/**
 * The part of a shared-database storage that is not SQL: admission and `close()`, the in-memory ID counter, the commit
 * call, read retries, and the cache of what `findDocument` read. A dialect's storage owns one and sends its own
 * statements through `read`, `findDocument` and `document`.
 */
export class StorageShell {
  readonly #name: string;
  readonly #lease: FencedLease;
  readonly #attempts: number;
  readonly #port: CommitPort;
  #nextId: number;
  #closed = false;
  #closing: Promise<void> | undefined;
  #active = 0;
  #drained: (() => void) | undefined;
  /**
   * Bumped as each commit starts and ends; with `#committing`, tells whether anything could have been written between
   * a read and a later use of what it read. Under the lease this storage is the scope's only writer.
   */
  #commitEpoch = 0;
  #committing = 0;
  /**
   * What `findDocument` read beside the record: the document's content at the same point, for the `document()` call
   * that follows it (pi-durable loads a document with the two, back to back). Used at most once, and only while no
   * commit started or ended since the read; one statement then serves both calls.
   */
  readonly #prefetched = new Map<string, { readonly rows: DocumentRows; readonly epoch: number }>();
  /** Current addresses `findDocument` found nothing at, while no commit has started or ended since. */
  readonly #absent = new Map<string, number>();

  constructor(options: StorageShellOptions) {
    this.#name = options.name;
    this.#lease = options.lease;
    this.#attempts = options.attempts;
    this.#port = options.port;
    this.#nextId = options.nextId;
  }

  /**
   * Stores `batches` through the port (`commitBatches`): one read of the check state, the checks in memory, and the
   * guarded write of every accepted batch. Refusals come from Durable's own checks only; a database failure rejects.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
  ): Promise<CommitResult> {
    return this.#admit(async () => {
      this.#committing++;
      this.#commitEpoch++;
      this.#prefetched.clear();
      this.#absent.clear();
      try {
        const { seqs, refused, nextId } = await commitBatches(
          this.#port,
          this.#lease,
          this.#attempts,
          batches,
          () => this.#nextId,
        );
        this.#nextId = Math.max(this.#nextId, nextId);
        // The write returned: the stored batches are durable.
        for (const [index, seq] of seqs.entries()) receive(index, seq);
        return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
      } finally {
        this.#committing--;
        this.#commitEpoch++;
      }
    });
  }

  /**
   * In memory, like upstream's SQLite storage: the counter starts at the scope's stored `next_id` and each commit
   * stores at least every ID it claimed plus one, so IDs never repeat across reopen.
   */
  async mintId<I extends Id<string>>(): Promise<I> {
    this.#assertOpen();
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
    return idFromNumber<I>(this.#nextId++);
  }

  /** Runs one of the storage's reads while open, again after a transient connection failure. */
  read<T>(read: () => Promise<T>): Promise<T> {
    return this.#admit(() => retry(this.#attempts, (error) => this.#port.isTransientError(error), read));
  }

  /**
   * The current document at `address` at `at`, from `find`'s rows: its record, and its content at the same point,
   * kept for the `document()` call that usually follows. A current address found empty is remembered until the next
   * commit: only a commit of this storage, the scope's single writer, can create a document there.
   */
  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    find: () => Promise<DocumentRows | undefined>,
  ): Promise<DocumentRecord | undefined> {
    return this.read(async () => {
      const absentKey = at === "current" ? addressKey(address) : undefined;
      if (absentKey !== undefined && this.#reusable(this.#absent.get(absentKey))) return undefined;
      const epoch = this.#committing === 0 ? this.#commitEpoch : undefined;
      const rows = await find();
      const fresh = epoch !== undefined && epoch === this.#commitEpoch;
      if (rows?.record === undefined) {
        if (fresh && absentKey !== undefined) this.#remember(this.#absent, absentKey, epoch);
        return undefined;
      }
      const record = parseJson<DocumentRecord>(rows.record);
      if (fresh) this.#remember(this.#prefetched, `${record.id}@${at}`, { rows, epoch });
      return record;
    });
  }

  /** Document `id` at `at` from `read`'s rows, or from what `findDocument` read of it with nothing committed since. */
  document(id: DocumentId, at: DocumentPoint, read: () => Promise<DocumentRows>): Promise<StoredDocument | undefined> {
    return this.read(async () => {
      const key = `${id}@${at}`;
      const prefetched = this.#prefetched.get(key);
      this.#prefetched.delete(key);
      if (prefetched !== undefined && this.#reusable(prefetched.epoch))
        return materializeDocument(prefetched.rows, id, at);
      return materializeDocument(await read(), id, at);
    });
  }

  /** Stops accepting calls and resolves once the calls already running settled. Leaves the database open. */
  close(): Promise<void> {
    if (this.#closing === undefined) {
      this.#closed = true;
      this.#closing =
        this.#active === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              this.#drained = resolve;
            });
    }
    return this.#closing;
  }

  /** Whether a read made at `epoch` still holds: no commit started or ended since, none running, the lease held. */
  #reusable(epoch: number | undefined): boolean {
    return epoch !== undefined && epoch === this.#commitEpoch && this.#committing === 0 && !this.#lease.signal.aborted;
  }

  #remember<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.size >= 256) map.clear();
    map.set(key, value);
  }

  /** Runs a call while open; `close()` waits for the calls it admitted, so none reaches the database after it. */
  async #admit<T>(call: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#active++;
    try {
      return await call();
    } finally {
      if (--this.#active === 0) this.#drained?.();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`${this.#name} is closed`);
  }
}
