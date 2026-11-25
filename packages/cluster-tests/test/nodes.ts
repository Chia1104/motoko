import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as z from "zod";

import { httpTransport, motokoClient, MotokoError } from "@chia1104/motoko-client";
import { createAgentRuntime, defineAgent, defineDeferredTool, defineTool, scopeKey } from "@chia1104/motoko-core";
import type { AgentRuntime, DeferredContext, DeliverReply, StorageScope, ToolContext } from "@chia1104/motoko-core";
import { motokoHandler, nodeHost, nodeListener } from "@chia1104/motoko-node";
import type { ClusterOptions, MotokoHandlerOptions, MotokoTarget } from "@chia1104/motoko-node";
import { createPostgresStore, migrate } from "@chia1104/motoko-store-postgres";
import type { PostgresStore, PostgresStoreOptions } from "@chia1104/motoko-store-postgres";
import {
  createPostgresStore as createPGliteStore,
  migrate as migratePGlite,
} from "@chia1104/motoko-store-postgres/pglite";

export interface Sent {
  readonly node: string;
  readonly to: string;
}

interface Ports {
  readonly node: string;
  readonly sent: Sent[];
}

const send = defineTool({
  name: "send",
  description: "Send a message",
  tier: "external",
  parameters: z.object({ to: z.string() }),
  async execute({ to }, { ports }: ToolContext<Ports>) {
    ports.sent.push({ node: ports.node, to });
    return { text: `sent to ${to}` };
  },
});

const clientAt = (base: string, user: string) =>
  motokoClient(httpTransport({ baseUrl: base, headers: { authorization: `Bearer ${user}` } }));

const ask = defineDeferredTool({
  name: "ask",
  description: "Ask another user's agent",
  tier: "read",
  parameters: z.object({ user: z.string(), sessionId: z.string(), question: z.string() }),
  async start({ user, sessionId, question }, { ports, requestId, replyTo }: DeferredContext<Ports>) {
    await clientAt(ports.node, user).submit(sessionId, { text: question, requestId, replyTo });
  },
});

export const agent = defineAgent({
  kind: "chat",
  instructions: "Chat.",
  tools: [send, ask],
  policy: { requiresApproval: ["external"] },
});

export interface Replied {
  readonly node: string;
  readonly outcome: string;
}

export const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const defaultModel = { provider: faux.provider.id, modelId: faux.getModel().id };

export const uniqueName = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

export const scopeOf = (name: string): StorageScope => ({ kind: agent.kind, name });

export interface LeaseRow {
  readonly holder: string | null;
  readonly held: boolean;
}

export interface Database {
  readonly name: string;
  store(options: PostgresStoreOptions): { store: PostgresStore; cut(): void; lastAt(): number };
  lease(scope: StorageScope): Promise<LeaseRow | undefined>;
  close(): Promise<void>;
}

const LEASE = `SELECT lease_holder AS holder, coalesce(lease_expires_at > clock_timestamp(), false) AS held
  FROM agent_runtime.scopes WHERE kind = $1 AND name = $2`;

function cuttable<C extends object>(client: C): { client: C; cut(): void; lastAt(): number } {
  let cut = false;
  let lastAt = Number.NaN;
  const proxy = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "query") return value.bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        if (cut) throw new Error("The machine is gone");
        const result: unknown = await value.apply(target, args);
        lastAt = performance.now();
        return result;
      };
    },
  });
  return { client: proxy, cut: () => void (cut = true), lastAt: () => lastAt };
}

export async function pgliteDatabase(): Promise<Database> {
  const pglite = await PGlite.create();
  await migratePGlite(pglite);
  return {
    name: "PGlite",
    store(options) {
      const { client, ...connection } = cuttable(pglite);
      return { store: createPGliteStore(client, options), ...connection };
    },
    async lease(scope) {
      return (await pglite.query<LeaseRow>(LEASE, [scope.kind, scope.name])).rows[0];
    },
    close: () => pglite.close(),
  };
}

export async function postgresDatabase(url: string): Promise<Database> {
  const name = `motoko_cluster_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const own = new URL(url);
  own.pathname = `/${name}`;
  const pools: pg.Pool[] = [];
  const pool = () => {
    const created = new pg.Pool({ connectionString: own.toString(), max: 4 });
    // An idle client whose connection drops emits `error` on the pool. Without a listener, Node exits.
    created.on("error", () => undefined);
    pools.push(created);
    return created;
  };
  const main = pool();
  await migrate(main);
  return {
    name: "Postgres",
    store(options) {
      const { client, ...connection } = cuttable(pool());
      return { store: createPostgresStore(client, options), ...connection };
    },
    async lease(scope) {
      return (await main.query<LeaseRow>(LEASE, [scope.kind, scope.name])).rows[0];
    },
    async close() {
      await Promise.all(pools.map((each) => each.end()));
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly call?: string;
}

export interface NodeOptions {
  readonly peers?: ClusterOptions["peers"];
  readonly connectTimeoutMs?: number;
  readonly resolve?: MotokoHandlerOptions<MotokoTarget>["resolve"];
  readonly authorize?: MotokoHandlerOptions<MotokoTarget>["authorize"];
  readonly ttlMs?: number;
}

export interface ClusterNode {
  readonly url: string;
  readonly runtime: AgentRuntime;
  readonly received: Received[];
  readonly opened: string[];
  readonly reported: unknown[];
  lastStatementAt(): number;
  cutAfterRunning(method: string): void;
  crash(): Promise<void>;
  close(): Promise<void>;
}

export function resolveUser(request: Request): MotokoTarget | Response {
  const name = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return name === undefined ? new Response("Sign in first", { status: 401 }) : { agent, name };
}

const callMethodOf = (body: string): string | undefined => {
  try {
    const { method } = JSON.parse(body) as { method?: unknown };
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
};

export function cluster(database: Database) {
  const nodes: ClusterNode[] = [];
  const sent: Sent[] = [];
  const replied: Replied[] = [];

  async function start(options: NodeOptions = {}): Promise<ClusterNode> {
    const received: Received[] = [];
    const opened: string[] = [];
    const reported: unknown[] = [];
    let cutting: string | undefined;
    let serve: ((request: Request) => Promise<Response>) | undefined;

    const server = createServer((req, res) => {
      nodeListener(
        async (request) => {
          const call = request.method === "POST" ? callMethodOf(await request.clone().text()) : undefined;
          received.push({
            method: request.method,
            path: new URL(request.url).pathname,
            headers: new Headers(request.headers),
            ...(call !== undefined && { call }),
          });
          const response = await serve!(request);
          if (call === undefined || call !== cutting) return response;
          cutting = undefined;
          await response.arrayBuffer();
          req.socket.destroy();
          return new Response(null, { status: 500 });
        },
        { onError: (error) => reported.push(error) },
      )(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/motoko`;
    const closeServer = () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    };

    const deliverReply: DeliverReply = async ({ to, text, isError }) => {
      const reply = { toolCallId: to.toolCallId, token: to.token, text, isError };
      try {
        replied.push({ node: url, ...(await clientAt(url, to.scope.name).reply(to.sessionId, reply)) });
      } catch (error) {
        const refused = error instanceof MotokoError && ["reply_not_pending", "session_not_found"].includes(error.code);
        if (!refused) throw error;
        replied.push({ node: url, outcome: "refused" });
      }
    };
    const { store, cut, lastAt } = database.store({
      holder: url,
      ...(options.ttlMs !== undefined && { ttlMs: options.ttlMs }),
    });
    const runtime = createAgentRuntime({
      agents: [agent],
      host: nodeHost({
        lease: (scope) => store.lease(scope),
        storage: (scope, lease) => {
          opened.push(scopeKey(scope));
          return store.storage(scope, lease);
        },
        unfinished: () => store.unfinished(),
        erase: (scope, lease, conversations) => store.erase(scope, lease, conversations),
      }),
      models,
      ports: { node: url, sent } satisfies Ports,
      defaultModel,
      deliverReply,
    });
    serve = motokoHandler(runtime, {
      basePath: "/motoko",
      resolve: options.resolve ?? resolveUser,
      ...(options.authorize !== undefined && { authorize: options.authorize }),
      onError: (error) => reported.push(error),
      cluster: {
        self: url,
        peers: options.peers ?? ((holder) => nodes.some((node) => node.url === holder)),
        ...(options.connectTimeoutMs !== undefined && { connectTimeoutMs: options.connectTimeoutMs }),
      },
    });

    let closing: Promise<void> | undefined;
    const node: ClusterNode = {
      url,
      runtime,
      received,
      opened,
      reported,
      lastStatementAt: lastAt,
      cutAfterRunning: (method) => void (cutting = method),
      async crash() {
        cut();
        await closeServer();
      },
      close: () =>
        (closing ??= (async () => {
          await closeServer();
          await runtime.close();
        })()),
    };
    nodes.push(node);
    return node;
  }

  return {
    sent,
    replied,
    start,
    async close(): Promise<void> {
      await Promise.all(nodes.splice(0).map((node) => node.close()));
      sent.length = 0;
      replied.length = 0;
    },
  };
}
