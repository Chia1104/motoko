import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  ConversationWindow,
  Cursor as PiCursor,
  EntryId,
  EntryRecord,
  Harness,
  Observation,
  Storage,
} from "@earendil-works/pi-durable";

import { decodeCursor, encodeCursor } from "@chia1104/motoko-wire";
import type { AgentWireEvent, Cursor, CursorPosition, StreamItem } from "@chia1104/motoko-wire";

import { InvalidCursorError } from "../errors.ts";

import { decisionsOf, gateArgsOf } from "./approvals.ts";
import { callsOf } from "./calls.ts";
import { ContinueEntry, inboxOf, isInput, joinsRun, liveOf, Transcriber } from "./transcriber.ts";
import type { Endings, History, Position, RunEnding, ToolInfo, Transcribed } from "./transcriber.ts";

const context = BACKGROUND_CONTEXT;
const PAGE = 200;
const WINDOW: ConversationWindow = { min: 1, max: 32 };

const busy = (view: ConversationView) => liveOf(view)?.run !== undefined || (inboxOf(view)?.items.length ?? 0) > 0;

// SAFETY: entry ids are numbers under pi-durable's brand; these bound scans of real ids.
const entryId = (id: number) => id as EntryId;

async function* pages(
  conversation: Conversation,
  min: number | undefined,
  max: number,
): AsyncGenerator<readonly EntryRecord[]> {
  if (max < 1 || (min !== undefined && min > max)) return;
  let cursor: PiCursor | undefined;
  do {
    const page = await conversation.entries(
      { ...(min !== undefined && { minEntryId: entryId(min) }), maxEntryId: entryId(max), order: "ascending" },
      PAGE,
      cursor,
      context,
    );
    if (page.items.length > 0) yield page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}

async function entryAt(conversation: Conversation, id: number): Promise<EntryRecord | undefined> {
  const page = await conversation.entries({ minEntryId: entryId(id), maxEntryId: entryId(id) }, 1, undefined, context);
  return page.items[0];
}

async function runStartBefore(conversation: Conversation, at: number): Promise<number | undefined> {
  if (at < 1) return undefined;
  const read: EntryRecord[] = [];
  let next = 0;
  let cursor: PiCursor | undefined;
  let done = false;
  for (;;) {
    for (; next < read.length; next += 1) {
      const entry = read[next]!;
      if (ContinueEntry.is(entry)) return entry.id;
      if (!isInput(entry)) continue;
      const previous = read[next + 1];
      const reply = read.slice(next + 1).find((before) => AssistantEntry.is(before));
      if (!done && (previous === undefined || reply === undefined)) break;
      if (joinsRun(entry, previous, reply) === undefined) return entry.id;
    }
    if (done) return undefined;
    const page = await conversation.entries({ maxEntryId: entryId(at), order: "descending" }, 50, cursor, context);
    read.push(...page.items);
    cursor = page.next;
    done = cursor === undefined;
  }
}

/** pi-durable settles an orphaned run's inputs with why it was orphaned; `pi.live` says `orphaned`. */
const ORPHANED = new Set(["missing_task", "task_too_old", "migration_failed"]);

/**
 * pi-durable commits each run's settlement with the run's end and keeps it, whereas `pi.live` keeps only the newest
 * run's. pi-durable scans submissions only on the Storage, so this reads the instance's Storage.
 */
async function endingsOf(storage: Storage, conversation: Conversation): Promise<Endings> {
  const inputs = new Map<number, RunEnding>();
  const continues = new Map<number, RunEnding>();
  let cursor: PiCursor | undefined;
  do {
    const page = await storage.scanSubmissions(
      { conversationId: conversation.id, status: "unanswered" },
      PAGE,
      cursor,
      context,
    );
    for (const record of page.items) {
      if (record.status !== "unanswered") continue;
      const detail = typeof record.detail === "string" ? record.detail : undefined;
      const ending: RunEnding = ORPHANED.has(record.reason)
        ? { reason: "orphaned", detail: record.reason }
        : { reason: record.reason, ...(detail !== undefined && { detail }) };
      if (record.type === "input" && record.entry !== undefined) inputs.set(record.entry, ending);
      else if (record.type === "continue") continues.set(record.id, ending);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { inputs, continues };
}

export function historyOf({
  harness,
  storage,
  conversation,
}: Pick<SessionWatchOptions, "harness" | "storage" | "conversation">): History {
  return {
    pages: (min, max) => pages(conversation, min, max),
    entry: (id) => entryAt(conversation, id),
    runStart: (at) => runStartBefore(conversation, at),
    decisions: () => decisionsOf(harness, conversation.id),
    gateArgs: (taskId) => gateArgsOf(harness, taskId),
    calls: () => callsOf(harness, conversation.id),
    endings: () => endingsOf(storage, conversation),
  };
}

interface Logged {
  readonly item: StreamItem;
  readonly position: Position;
}

interface Reader {
  seq: number;
  position: Position;
}

export interface SessionWatchOptions {
  readonly harness: Harness;
  /** The Storage the Harness was opened on, for the reads pi-durable offers only there. */
  readonly storage: Storage;
  readonly conversation: Conversation;
  readonly info: (toolName: string) => ToolInfo;
  readonly report: (error: unknown) => void;
  readonly onClose: (watch: SessionWatch) => void;
}

export class SessionWatch {
  readonly epoch: string = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  readonly ready: Promise<void>;
  readonly #options: SessionWatchOptions;
  readonly #session: string;
  readonly #history: History;
  readonly #transcriber: Transcriber;
  #observation: Observation<ConversationView> | undefined;
  #view: ConversationView | undefined;
  #log: Logged[] = [];
  #base = 0;
  #currentRun = 0;
  #previousRun = 0;
  readonly #readers = new Set<Reader>();
  readonly #waiters = new Set<() => void>();
  #holds = 0;
  #queued = 0;
  #chain: Promise<void> = Promise.resolve();
  #built = false;
  #closed = false;

  constructor(options: SessionWatchOptions) {
    this.#options = options;
    this.#session = String(options.conversation.id);
    this.#history = historyOf(options);
    this.#transcriber = new Transcriber(this.#history, options.info);
    this.ready = this.#start();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get held(): { readonly events: number; readonly readers: number } {
    return { events: this.#log.length, readers: this.#readers.size };
  }

  get #end(): number {
    return this.#base + this.#log.length;
  }

  get #newest(): number {
    return this.#transcriber.position.entry;
  }

  hold(): () => void {
    this.#holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds -= 1;
      this.#settle();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#observation?.detach();
    this.#observation = undefined;
    this.#log = [];
    this.#readers.clear();
    this.#wake();
    this.#options.onClose(this);
  }

  #settle() {
    if (this.#closed || !this.#built || this.#holds > 0 || this.#queued > 0) return;
    if (this.#view !== undefined && busy(this.#view)) return;
    this.close();
  }

  #cursor(position: Position, log?: { epoch: string; seq: number }): Cursor {
    const at: CursorPosition = {
      session: this.#session,
      entry: position.entry,
      ...(position.run !== undefined && { run: position.run }),
      ...(log !== undefined && { log }),
    };
    return encodeCursor(at);
  }

  async #start(): Promise<void> {
    const { harness, conversation } = this.#options;
    const waiting: ConversationView[] = [];
    let take = (view: ConversationView) => {
      waiting.push(view);
    };
    const observation = await harness.observeConversation(
      conversation.id,
      {
        // pi-durable calls this as it adopts a commit, where nothing may wait or throw, so this only records the view.
        advance(call) {
          if (call.kind === "value") take(call.value);
        },
        end: () => this.close(),
      },
      context,
      WINDOW,
    );
    if (this.#closed) {
      observation.detach();
      return;
    }
    this.#observation = observation;
    try {
      this.#view = observation.value;
      await this.#transcriber.start(observation.value);
    } catch (error) {
      this.close();
      throw error;
    }
    this.#built = true;
    take = (next) => this.#enqueue(() => this.#step(next));
    for (const next of waiting) take(next);
    this.#settle();
  }

  #enqueue(task: () => Promise<void>) {
    this.#queued += 1;
    this.#chain = this.#chain
      .then(task)
      .catch((error: unknown) => {
        if (!this.#closed) this.#options.report(error);
      })
      .finally(() => {
        this.#queued -= 1;
        this.#settle();
      });
  }

  #inChain<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#enqueue(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async #step(next: ConversationView) {
    if (this.#closed || !this.#view) return;
    const transcribed = await this.#transcriber.commit(this.#view, next);
    this.#view = next;
    for (const { event, position } of transcribed) this.#push(event, position);
  }

  #push(event: AgentWireEvent, position: Position) {
    if (this.#closed) return;
    const seq = this.#end + 1;
    this.#log.push({ item: { cursor: this.#cursor(position, { epoch: this.epoch, seq }), event }, position });
    if (event.type === "run:start") {
      this.#previousRun = this.#currentRun;
      this.#currentRun = seq - 1;
      this.#trim();
    }
    this.#wake();
  }

  #trim() {
    let keep = this.#currentRun;
    for (const reader of this.#readers) keep = Math.min(keep, reader.seq);
    keep = Math.max(keep, this.#previousRun);
    if (keep <= this.#base) return;
    this.#log.splice(0, keep - this.#base);
    this.#base = keep;
  }

  #wake() {
    for (const waiter of [...this.#waiters]) waiter();
  }

  #next(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  #parse(from: Cursor | string | undefined): CursorPosition | undefined {
    if (from === undefined) return undefined;
    const position = decodeCursor(from);
    if (position === undefined || position.session !== this.#session) throw new InvalidCursorError(from);
    if (position.log?.epoch === this.epoch && position.log.seq > this.#end) throw new InvalidCursorError(from);
    return position;
  }

  async *read(
    from: Cursor | string | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamItem, void, undefined> {
    const release = this.hold();
    let reader: Reader | undefined;
    try {
      await this.ready;
      const start = this.#parse(from);
      let position: Position | undefined = start;
      if (start?.log?.epoch === this.epoch && start.log.seq >= this.#base && !this.#closed) {
        reader = { seq: start.log.seq, position: start };
        this.#readers.add(reader);
      }
      while (!this.#closed && !signal?.aborted) {
        if (reader === undefined) {
          reader = yield* this.#catchUp(position);
          if (reader === undefined) return;
        }
        while (reader.seq >= this.#base && reader.seq < this.#end) {
          const logged = this.#log[reader.seq - this.#base]!;
          reader.seq += 1;
          reader.position = logged.position;
          yield logged.item;
          if (this.#closed || signal?.aborted) return;
          if (reader.seq > this.#currentRun && this.#base < this.#currentRun) this.#trim();
        }
        if (reader.seq < this.#base) {
          this.#readers.delete(reader);
          position = reader.position;
          reader = undefined;
          continue;
        }
        if (this.#closed || signal?.aborted) return;
        await this.#next(signal);
      }
    } finally {
      if (reader) this.#readers.delete(reader);
      release();
    }
  }

  async *#catchUp(from: Position | undefined): AsyncGenerator<StreamItem, Reader | undefined, undefined> {
    const { info } = this.#options;
    let transcriber = new Transcriber(this.#history, info);
    const held: Logged[] = [];
    const hold = (transcribed: readonly Transcribed[]) => {
      for (const { event, position } of transcribed) {
        held.push({ item: { cursor: this.#cursor(position), event }, position });
      }
    };
    try {
      if (from !== undefined && !(await transcriber.restore(from))) {
        transcriber = new Transcriber(this.#history, info);
        yield { cursor: this.#cursor({ entry: 0 }), event: { type: "stream:reset" } };
      }
      hold(transcriber.standing(this.#view));
      for await (const page of transcriber.replay(this.#newest)) {
        hold(page);
        for (const { item } of held.splice(0, held.length - 1)) yield item;
      }
      const reader = await this.#inChain(async (): Promise<Reader | undefined> => {
        if (this.#closed || !this.#view) return undefined;
        hold(await transcriber.catchUp(this.#newest, this.#view));
        if (this.#closed) return undefined;
        const joined: Reader = { seq: this.#end, position: transcriber.position };
        this.#readers.add(joined);
        const last = held.at(-1);
        if (last) {
          held[held.length - 1] = {
            ...last,
            item: { ...last.item, cursor: this.#cursor(last.position, { epoch: this.epoch, seq: joined.seq }) },
          };
        }
        return joined;
      });
      for (const { item } of held.splice(0)) yield item;
      return reader;
    } catch (error) {
      if (this.#closed) return undefined;
      throw error;
    }
  }
}
