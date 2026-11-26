import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationRecord,
  DocumentContent,
  DocumentCopySource,
  DocumentCreate,
  DocumentId,
  DocumentRecord,
  EntryRecord,
  Seq,
  StorageWrite,
  StoredDocument,
  SubmissionRecord,
  TaskRecord,
} from "@earendil-works/pi-durable";

import { ConcurrentCommitError, LeaseLostError, ScopeDeletedError } from "./errors.ts";
import type { FencedLease } from "./lease.ts";
import { backoff, retry } from "./retry.ts";
import { addressKey, addressParts, encodeJson, isCurrentOnly, partsKey, seqFromNumber } from "./rows.ts";
import type { AddressParts } from "./rows.ts";

/** The table an ID is claimed for. */
export type RecordTable = "conversation" | "entry" | "task" | "submission" | "document";

/** What the checks of one call's batches read beside the scope's counters. */
export interface CheckQuery {
  /** IDs whose claim to read. */
  readonly ids: readonly number[];
  /** Documents whose record to read. */
  readonly documents: readonly number[];
  /** Documents whose latest revision's version to read. */
  readonly deltas: readonly number[];
  /** Addresses whose current, unretired document to read. */
  readonly addresses: readonly AddressParts[];
}

/** The scope's row and the stored state a `CheckQuery` names, read in one snapshot. */
export interface CheckState {
  readonly nextId: number;
  readonly nextSeq: number;
  readonly leaseToken: number;
  /** The table of each claimed ID among the queried ones. */
  readonly claims: readonly (readonly [id: number, table: RecordTable])[];
  /** The record of each stored document among the queried ones. */
  readonly documents: readonly DocumentRecord[];
  /** The latest revision's version of each queried document that has a revision. */
  readonly versions: readonly (readonly [document: number, version: number])[];
  /** The current document at each queried address that has one. */
  readonly current: readonly (readonly [document: number, address: AddressParts])[];
}

/** What the write of a plan requires and advances. */
export interface CommitGuard {
  /** The scope's `next_seq` that this call read or last wrote. Any other commit since then changed it. */
  readonly expectedSeq: number;
  readonly nextSeq: number;
  /** The scope's `next_id` becomes at least this. */
  readonly nextId: number;
  /** The fencing token of the lease the storage holds. The write stores nothing unless it is current and unexpired. */
  readonly leaseToken: number;
}

/** A new revision of a document, its content as JSON text. */
export interface PlannedRevision {
  readonly document: number;
  readonly seq: number;
  readonly kind: "base" | "delta";
  readonly version: number;
  readonly content: string;
}

/**
 * The net effect, per table, of the accepted batches not yet written. A task or submission written twice is written
 * once, as last written. A current-only document's revisions before its latest base or retirement are dropped, and its
 * stored ones deleted.
 */
export interface CommitPlan {
  /**
   * IDs the plan claims first. An ID claimed before, such as a task or submission written again, keeps its claim and is
   * left out, so a plan that only rewrites records claims nothing.
   */
  readonly claims: readonly (readonly [id: number, table: RecordTable])[];
  readonly conversations: readonly ConversationRecord[];
  /** Each entry, with the seq of the batch that stored it. */
  readonly entries: readonly { readonly record: EntryRecord; readonly seq: number }[];
  /** Tasks to insert, or whose stored row to replace. */
  readonly tasks: readonly TaskRecord<JsonValue, JsonValue, JsonValue>[];
  /** Submissions to insert, or whose stored row to replace. */
  readonly submissions: readonly SubmissionRecord[];
  /**
   * Documents to insert because the plan created them, or whose stored row to replace because the plan retired them.
   * Each record is as the plan leaves it.
   */
  readonly documents: readonly DocumentRecord[];
  /**
   * Documents whose stored revisions are deleted. None of `revisions` is among the ones deleted. A document the plan
   * creates has none stored, so it is left out.
   */
  readonly cleared: readonly number[];
  /** New revisions, in seq order per document. */
  readonly revisions: readonly PlannedRevision[];
}

/**
 * How a plan's write ended without an error. It is `stored`, or it says why the guard refused the write, which then
 * wrote nothing. `deleted` means the scope's row is gone, `taken` that its lease token is another holder's, and
 * `expired` that the lease expired. `concurrent` means none of those, so another storage under the same lease
 * committed first.
 */
export type WriteOutcome = "stored" | "deleted" | "taken" | "expired" | "concurrent";

/** What one storage of a shared-database store sends for its commits, in its scope. */
export interface CommitPort {
  /** Reads the scope's row and what `query` names in one snapshot. It is `undefined` when the scope's row is gone. */
  read(query: CheckQuery): Promise<CheckState | undefined>;
  /**
   * Writes `plan` atomically, only if `guard` holds. The guard holds when the scope's `next_seq` still equals
   * `guard.expectedSeq` and its lease token is `guard.leaseToken` and unexpired by the database clock. The write then
   * sets `next_seq` to `guard.nextSeq` and `next_id` to at least `guard.nextId`. A rejection is an unknown outcome
   * when the dialect's `isTransientError` says so, and the plan may be written again.
   */
  write(guard: CommitGuard, plan: CommitPlan): Promise<WriteOutcome>;
  /**
   * Reads a copy's source as stored. The function it resolves returns the source's content, or throws when the stored
   * rows hold none to copy.
   */
  readSource(source: DocumentCopySource): Promise<() => StoredDocument | undefined>;
  /** A failure of the connection, not of the statement, so an idempotent statement may be sent again. */
  isTransientError(error: unknown): boolean;
}

const NOTHING: CheckQuery = { ids: [], documents: [], deltas: [], addresses: [] };

/**
 * One `Storage.commit()` of `batches` to the lease's scope. It reads the scope's row and refuses unless the lease token
 * is still the scope's. It checks each batch against what the batches before it left, then writes the accepted ones
 * under the guard. A batch with a document copy writes the batches before it and reads the copy's source first. Every
 * read and write is sent at most `attempts` times. A lease found lost is marked lost with `lease.lose` before the call
 * rejects.
 *
 * `unminted` is the storage's lowest unminted ID, read as each write is sent. The scope's `next_id` is left at least
 * that, so no ID minted before is minted again after reopen.
 *
 * Resolves the seq of each stored batch, the refusal that stopped the call, and `nextId`. `nextId` is one past the
 * highest ID the stored batches claim, or 0 with none, and is the least the storage's next ID may be.
 */
export async function commitBatches(
  port: CommitPort,
  lease: FencedLease,
  attempts: number,
  batches: readonly (readonly StorageWrite[])[],
  unminted: () => number,
): Promise<{ seqs: Seq[]; refused: { error: unknown } | undefined; nextId: number }> {
  if (lease.signal.aborted) throw lease.signal.reason ?? new LeaseLostError(lease.scope, "expired");
  const transient = (error: unknown) => port.isTransientError(error);
  const read = await CommitState.read(port, attempts, batches);
  if (read === undefined) {
    lease.lose("deleted");
    throw new ScopeDeletedError(lease.scope);
  }
  const { state, counters } = read;
  if (counters.leaseToken !== lease.token) {
    lease.lose("taken");
    throw lease.signal.reason;
  }
  const seqs: Seq[] = [];
  let refused: { error: unknown } | undefined;
  let nextId = 0;
  let written = counters.nextSeq;
  let next = counters.nextSeq;
  const pending = new PendingWrites();
  const flush = async () => {
    if (next === written) return;
    await writePlan(port, lease, attempts, pending.plan(), {
      expectedSeq: written,
      nextSeq: next,
      nextId: Math.max(counters.nextId, nextId, unminted()),
      leaseToken: lease.token,
    });
    pending.clear();
    written = next;
  };
  for (const writes of batches) {
    let actions: Map<DocumentId, DocumentAction>;
    try {
      actions = prepareDocumentActions(writes);
      state.check(writes, actions);
    } catch (error) {
      refused = { error };
      break;
    }
    if ([...actions.values()].some((action) => action.copy !== undefined)) {
      await flush();
      refused = await resolveCopies(actions, (source) => retry(attempts, transient, () => port.readSource(source)));
      if (refused !== undefined) break;
    }
    const seq = seqFromNumber(next++);
    const { records, claims } = state.apply(writes, actions, seq);
    pending.add(writes, actions, seq, records, claims);
    seqs.push(seq);
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim !== undefined) nextId = Math.max(nextId, claim.id + 1);
    }
  }
  await flush();
  return { seqs, refused, nextId };
}

async function writePlan(
  port: CommitPort,
  lease: FencedLease,
  attempts: number,
  plan: CommitPlan,
  guard: CommitGuard,
): Promise<void> {
  const transient = (error: unknown) => port.isTransientError(error);
  for (let attempt = 1; ; attempt++) {
    let outcome: WriteOutcome;
    try {
      outcome = await port.write(guard, plan);
    } catch (error) {
      if (!transient(error) || attempt >= attempts) throw error;
      await backoff(attempt);
      const settled = await outcomeOfUnknownWrite(port, attempts, lease.token, guard);
      if (settled === "deleted") {
        lease.lose("deleted", error);
        throw new ScopeDeletedError(lease.scope);
      }
      if (settled === "taken") {
        lease.lose("taken", error);
        throw lease.signal.reason;
      }
      if (settled === "stored") return;
      if (settled === "resend") continue;
      throw error;
    }
    if (outcome === "stored") return;
    if (outcome === "deleted") {
      lease.lose("deleted");
      throw new ScopeDeletedError(lease.scope);
    }
    if (outcome !== "concurrent") lease.lose(outcome);
    if (lease.signal.aborted) throw lease.signal.reason;
    throw new ConcurrentCommitError(lease.scope);
  }
}

async function outcomeOfUnknownWrite(
  port: CommitPort,
  attempts: number,
  leaseToken: number,
  guard: CommitGuard,
): Promise<"deleted" | "taken" | "stored" | "resend" | "unknown"> {
  const now = await retry(
    attempts,
    (error) => port.isTransientError(error),
    () => port.read(NOTHING),
  );
  if (now === undefined) return "deleted";
  if (now.leaseToken !== leaseToken) return "taken";
  if (now.nextSeq === guard.nextSeq) return "stored";
  if (now.nextSeq === guard.expectedSeq) return "resend";
  return "unknown";
}

async function resolveCopies(
  actions: Map<DocumentId, DocumentAction>,
  readSource: (source: DocumentCopySource) => Promise<() => StoredDocument | undefined>,
): Promise<{ error: unknown } | undefined> {
  for (const [id, action] of actions) {
    const source = action.copy;
    if (source === undefined) continue;
    const materialize = await readSource(source);
    try {
      const stored = materialize();
      if (stored === undefined) throw new Error(`Fork source document ${source.id} cannot be read`);
      const create = action.create as DocumentRecord;
      if (
        stored.record.scope.kind !== "conversation" ||
        create.scope.kind !== "conversation" ||
        stored.record.kind !== create.kind ||
        stored.record.key !== create.key ||
        stored.record.history !== create.history ||
        stored.record.fork !== create.fork
      ) {
        throw new Error(`Fork source document ${source.id} does not match the copied record`);
      }
      action.content = { kind: "base", version: stored.version, value: stored.value };
    } catch (error) {
      return { error: new Error(`Document copy ${id} was rejected`, { cause: error }) };
    }
  }
  return undefined;
}

const claimOf = (write: StorageWrite): { id: number; table: RecordTable } | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return { id: write.value.id, table: write.type };
    case "document.create":
    case "document.copy":
      return { id: write.record.id, table: "document" };
    case "document.change":
    case "document.retire":
      return undefined;
  }
};

interface DocumentAction {
  create?: DocumentCreate;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
}

function prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
  const actions = new Map<DocumentId, DocumentAction>();
  for (const write of writes) {
    if (
      write.type !== "document.create" &&
      write.type !== "document.copy" &&
      write.type !== "document.change" &&
      write.type !== "document.retire"
    ) {
      continue;
    }
    const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    switch (write.type) {
      case "document.create":
        if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.create = write.record;
        action.content = write.content;
        break;
      case "document.copy":
        if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.create = write.record;
        action.copy = write.source;
        break;
      case "document.change":
        if (action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.content = write.content;
        break;
      case "document.retire":
        if (action.retire) throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
        break;
    }
  }
  return actions;
}

interface ScopeCounters {
  readonly nextId: number;
  readonly nextSeq: number;
  readonly leaseToken: number;
}

type CurrentDocument = { readonly exists: false } | { readonly exists: true; readonly id: number };
const NO_CURRENT_DOCUMENT: CurrentDocument = { exists: false };

class CommitState {
  readonly #recordIds: Map<number, RecordTable>;
  readonly #documents: Map<number, DocumentRecord>;
  readonly #versions: Map<number, number>;
  readonly #createdAddresses: Map<string, CurrentDocument>;

  private constructor(
    recordIds: Map<number, RecordTable>,
    documents: Map<number, DocumentRecord>,
    versions: Map<number, number>,
    createdAddresses: Map<string, CurrentDocument>,
  ) {
    this.#recordIds = recordIds;
    this.#documents = documents;
    this.#versions = versions;
    this.#createdAddresses = createdAddresses;
  }

  static async read(
    port: CommitPort,
    attempts: number,
    batches: readonly (readonly StorageWrite[])[],
  ): Promise<{ state: CommitState; counters: ScopeCounters } | undefined> {
    const ids = new Set<number>();
    const documentIds = new Set<number>();
    const deltaIds = new Set<number>();
    const addresses = new Map<string, AddressParts>();
    for (const writes of batches) {
      for (const write of writes) {
        const claim = claimOf(write);
        if (claim !== undefined) ids.add(claim.id);
        switch (write.type) {
          case "document.create":
          case "document.copy":
            documentIds.add(write.record.id);
            addresses.set(addressKey(write.record as DocumentRecord), addressParts(write.record as DocumentRecord));
            break;
          case "document.change":
            documentIds.add(write.id);
            if (write.content.kind === "delta") deltaIds.add(write.id);
            break;
          case "document.retire":
            documentIds.add(write.id);
            break;
          default:
            break;
        }
      }
    }
    const query: CheckQuery = {
      ids: [...ids],
      documents: [...documentIds],
      deltas: [...deltaIds],
      addresses: [...addresses.values()],
    };
    const row = await retry(
      attempts,
      (error) => port.isTransientError(error),
      () => port.read(query),
    );
    if (row === undefined) return undefined;
    const createdAddresses = new Map<string, CurrentDocument>();
    for (const key of addresses.keys()) createdAddresses.set(key, NO_CURRENT_DOCUMENT);
    for (const [id, address] of row.current) createdAddresses.set(partsKey(address), { exists: true, id });
    return {
      state: new CommitState(
        new Map(row.claims),
        new Map(row.documents.map((record) => [record.id, record])),
        new Map(row.versions),
        createdAddresses,
      ),
      counters: { nextId: row.nextId, nextSeq: row.nextSeq, leaseToken: row.leaseToken },
    };
  }

  check(writes: readonly StorageWrite[], actions: Map<DocumentId, DocumentAction>): void {
    this.#checkIds(writes);
    this.#checkDocuments(actions);
  }

  apply(
    writes: readonly StorageWrite[],
    actions: Map<DocumentId, DocumentAction>,
    seq: Seq,
  ): { records: Map<DocumentId, DocumentRecord>; claims: Map<number, RecordTable> } {
    const claims = new Map<number, RecordTable>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      if (!this.#recordIds.has(claim.id)) claims.set(claim.id, claim.table);
      this.#recordIds.set(claim.id, claim.table);
    }
    const records = new Map<DocumentId, DocumentRecord>();
    for (const [id, action] of actions) {
      if (action.create !== undefined) {
        const record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        this.#documents.set(id, record);
        if (!action.retire) this.#createdAddresses.set(addressKey(record), { exists: true, id });
      } else if (action.retire) {
        const record = { ...this.#documents.get(id), retiredAt: seq } as DocumentRecord;
        this.#documents.set(id, record);
        const key = addressKey(record);
        const current = this.#createdAddresses.get(key);
        if (current?.exists === true && current.id === id) this.#createdAddresses.set(key, NO_CURRENT_DOCUMENT);
      }
      if (action.content !== undefined) this.#versions.set(id, action.content.version);
      records.set(id, this.#documents.get(id) as DocumentRecord);
    }
    return { records, claims };
  }

  #checkIds(writes: readonly StorageWrite[]): void {
    const claimed = new Map<number, RecordTable>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      const { id, table } = claim;
      const existing = this.#recordIds.get(id);
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  #checkDocuments(actions: Map<DocumentId, DocumentAction>): void {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) {
        throw new Error(`Document copy ${id} source is changed in the copy batch`);
      }
      const existing = this.#documents.get(id);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = this.#versions.get(id);
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
      }
      if (action.create === undefined && !action.retire) continue;
      const key = addressKey((action.create as DocumentRecord | undefined) ?? (existing as DocumentRecord));
      const current = this.#createdAddresses.get(key);
      if (current === undefined) continue;
      let live = liveCounts.get(key) ?? (current.exists ? 1 : 0);
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }
}

class PendingWrites {
  #recordIds = new Map<number, RecordTable>();
  #conversations: ConversationRecord[] = [];
  #entries: { record: EntryRecord; seq: number }[] = [];
  #tasks = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  #submissions = new Map<number, SubmissionRecord>();
  #documents = new Map<number, DocumentRecord>();
  #cleared = new Set<number>();
  #created = new Set<number>();
  #revisions = new Map<number, PlannedRevision[]>();

  add(
    writes: readonly StorageWrite[],
    actions: Map<DocumentId, DocumentAction>,
    seq: Seq,
    records: Map<DocumentId, DocumentRecord>,
    claims: Map<number, RecordTable>,
  ): void {
    for (const [id, table] of claims) this.#recordIds.set(id, table);
    for (const write of writes) this.#addWrite(write, seq);
    for (const [id, action] of actions) this.#addDocument(id, action, seq, records.get(id) as DocumentRecord);
  }

  #addWrite(write: StorageWrite, seq: number): void {
    switch (write.type) {
      case "conversation":
        this.#conversations.push(write.value);
        break;
      case "entry":
        this.#entries.push({ record: write.value, seq });
        break;
      case "task":
        this.#tasks.set(write.value.id, write.value);
        break;
      case "submission":
        this.#submissions.set(write.value.id, write.value);
        break;
      default:
        break;
    }
  }

  #addDocument(id: number, action: DocumentAction, seq: number, record: DocumentRecord): void {
    if (action.create !== undefined || action.retire) this.#documents.set(id, record);
    if (action.create !== undefined) this.#created.add(id);
    const content = action.content;
    if (content !== undefined) {
      if (content.kind === "base" && isCurrentOnly(record)) this.#discardRevisions(id);
      const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
      let revisions = this.#revisions.get(id);
      if (revisions === undefined) {
        revisions = [];
        this.#revisions.set(id, revisions);
      }
      revisions.push({ document: id, seq, kind: content.kind, version: content.version, content: encoded });
    }
    if (action.retire && isCurrentOnly(record)) this.#discardRevisions(id);
  }

  #discardRevisions(id: number): void {
    if (!this.#created.has(id)) this.#cleared.add(id);
    this.#revisions.delete(id);
  }

  plan(): CommitPlan {
    return {
      claims: [...this.#recordIds],
      conversations: this.#conversations,
      entries: this.#entries,
      tasks: [...this.#tasks.values()],
      submissions: [...this.#submissions.values()],
      documents: [...this.#documents.values()],
      cleared: [...this.#cleared],
      revisions: [...this.#revisions.values()].flat(),
    };
  }

  clear(): void {
    this.#recordIds.clear();
    this.#conversations = [];
    this.#entries = [];
    this.#tasks.clear();
    this.#submissions.clear();
    this.#documents.clear();
    this.#cleared.clear();
    this.#created.clear();
    this.#revisions.clear();
  }
}
