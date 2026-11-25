import type { Context } from "@earendil-works/chord/context";
import { ToolTask } from "@earendil-works/pi-durable";
import type {
  Extension,
  HookRegistration,
  JsonObject,
  ToolExecutionApi,
  ToolHooks,
  ToolRegistration,
} from "@earendil-works/pi-durable";

import { UNKNOWN_TIER } from "@chia1104/motoko-wire";

import type { AgentDefinition } from "../agent.ts";
import type { StorageScope } from "../host.ts";

import { CallsDoc, startedCall } from "./calls.ts";

/** One of the app's pi-durable extensions, as `extensionsFor` hands it to an instance. */
export interface AppExtension {
  /** Its tools, prompt sections, hooks, wraps and tasks, as pi-durable runs them. */
  readonly extension: Extension;
  /**
   * The tier of each of its tools, by name. The agent's policy and a session's rule judge it as they judge the tiers of
   * the agent's own tools. A tool it gives no tier is `unknown`, and every call of it waits for approval.
   */
  readonly tier?: (toolName: string) => string | undefined;
  /**
   * The agent kinds whose sessions select it. Default: the instance's own agent alone, so no sub-agent of a delegate
   * runs it unless named here.
   */
  readonly agents?: readonly string[];
}

/** The app's extensions for one instance, from its scope. */
export type ExtensionsResolver = (scope: StorageScope) => readonly AppExtension[] | Promise<readonly AppExtension[]>;

export interface GatedTool {
  readonly name: string;
  readonly label: string;
  readonly tier?: string;
}

export interface ToolCatalog {
  tool(kind: string, name: string): GatedTool;
  tiers(kind: string): ReadonlySet<string>;
}

export interface AppExtensions {
  readonly catalog: ToolCatalog;
  readonly installed: readonly Extension[];
  selectionOf(kind: string, own: Extension): [...app: Extension[], ownGateJudgesLast: Extension];
}

async function parkedOnItsOwn(api: ToolExecutionApi, context: Context) {
  await api.commit(async (tx) => {
    const calls = await tx.doc(CallsDoc, api.conversationId);
    if (startedCall(calls.calls, api.callId, api.taskId) === undefined) {
      calls.calls[api.callId] = { kind: "app", taskId: api.taskId };
    }
  }, context);
}

const withParksRecorded = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  async execute(args, api, context) {
    const result = await tool.execute(args, api, context);
    if ("sleep" in result && result.sleep !== undefined) await parkedOnItsOwn(api, context);
    return result;
  },
});

export const MODEL_ARGS = "motoko.model.args";

function appToolHooks(extension: string, registration: HookRegistration): HookRegistration {
  // SAFETY: a registration for the tool task holds its hooks, as `hook(ToolTask, ...)` types them.
  const handlers = registration.handlers as Partial<ToolHooks>;
  const { beforeTool } = handlers;
  if (beforeTool === undefined) return registration;
  const hooks: Partial<ToolHooks> = {
    ...handlers,
    async beforeTool(call, api, context) {
      const decision = await beforeTool.call(handlers, call, api, context);
      if (decision?.block !== undefined) return decision;
      if (decision?.sleep !== undefined) {
        return { block: `an app hook cannot make a call wait (app extension \`${extension}\`)` };
      }
      if (decision?.arguments !== undefined) {
        // The first write wins. A hook before this one that rewrote the call memoized the arguments it was handed.
        // SAFETY: pi-ai's JSON arguments differ from pi-durable's JSON only in typing their arrays readonly.
        await api.memo(MODEL_ARGS, call.arguments as JsonObject, context);
      }
      return decision;
    },
  };
  return { ...registration, handlers: hooks };
}

const installable = (extension: Extension): Extension => ({
  ...extension,
  ...(extension.tools !== undefined && { tools: extension.tools.map(withParksRecorded) }),
  ...(extension.hooks !== undefined && {
    hooks: extension.hooks.map((registration) =>
      registration.task === ToolTask.definition.name ? appToolHooks(extension.name, registration) : registration,
    ),
  }),
});

/**
 * pi-durable runs the last selected extension that provides or wraps a tool of a name, so an app extension that
 * shadows or wraps an agent's tool would run in its place, past its ports.
 */
export function appExtensions(
  scope: StorageScope,
  agents: ReadonlyMap<string, AgentDefinition>,
  app: readonly AppExtension[],
): AppExtensions {
  if (!Array.isArray(app)) throw new TypeError("`extensionsFor` must return a list of app extensions");
  const agentTools = new Map<string, string>();
  for (const agent of agents.values()) for (const tool of agent.tools) agentTools.set(tool.name, agent.kind);
  const extensionNames = new Set<string>();
  const toolExtensions = new Map<string, string>();
  for (const { extension } of app) {
    const name = extension?.name;
    if (typeof name !== "string") throw new TypeError("An app extension must be a pi-durable extension with a name");
    if (name.startsWith("runtime:")) {
      throw new TypeError(`App extension \`${name}\` takes a name of the runtime's: \`runtime:\` names are Motoko's`);
    }
    if (extensionNames.has(name)) throw new TypeError(`Two app extensions are named \`${name}\``);
    extensionNames.add(name);
    for (const tool of extension.tools ?? []) {
      const agent = agentTools.get(tool.name);
      if (agent !== undefined) {
        throw new TypeError(`App extension \`${name}\` has tool \`${tool.name}\`, which agent \`${agent}\` has`);
      }
      const other = toolExtensions.get(tool.name);
      if (other !== undefined) {
        throw new TypeError(`App extensions \`${other}\` and \`${name}\` both have tool \`${tool.name}\``);
      }
      toolExtensions.set(tool.name, name);
    }
    for (const wrap of extension.wraps ?? []) {
      const agent = "tool" in wrap ? agentTools.get(wrap.tool) : undefined;
      if (agent !== undefined) {
        throw new TypeError(`App extension \`${name}\` wraps tool \`${wrap.tool}\` of agent \`${agent}\``);
      }
    }
  }

  const selects = (entry: AppExtension, kind: string) => (entry.agents ?? [scope.kind]).includes(kind);
  const installed = app.map((entry) => ({ entry, extension: installable(entry.extension) }));

  const kinds = new Map<string, { tools: Map<string, GatedTool>; tiers: Set<string> }>();
  for (const agent of agents.values()) {
    const tools = new Map<string, GatedTool>(
      agent.tools.map((tool) => [tool.name, { name: tool.name, label: tool.label, tier: tool.tier }]),
    );
    for (const entry of app) {
      if (!selects(entry, agent.kind)) continue;
      for (const { name } of entry.extension.tools ?? []) {
        const given = entry.tier?.(name);
        const tier = given === undefined || given === UNKNOWN_TIER ? undefined : given;
        tools.set(name, { name, label: name, ...(tier !== undefined && { tier }) });
      }
    }
    const tiers = new Set<string>();
    for (const { tier } of tools.values()) if (tier !== undefined) tiers.add(tier);
    kinds.set(agent.kind, { tools, tiers });
  }
  const none = new Set<string>();

  return {
    catalog: {
      tool: (kind, name) => kinds.get(kind)?.tools.get(name) ?? { name, label: name },
      tiers: (kind) => kinds.get(kind)?.tiers ?? none,
    },
    installed: installed.map(({ extension }) => extension),
    selectionOf: (kind, own) => [
      ...installed.filter(({ entry }) => selects(entry, kind)).map(({ extension }) => extension),
      own,
    ],
  };
}
