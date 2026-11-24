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
   * The tier of each of its tools, by name: what the agent's policy and a session's rule judge, as they judge the
   * agent's own tools. A tool it gives no tier is `unknown`, and every call of it waits for approval.
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

/** What the gate, `decide` and a session's stream know of a tool a session runs. */
export interface GatedTool {
  readonly name: string;
  readonly label: string;
  /** Absent: the tool's tier is unknown, and every call of it waits for approval. */
  readonly tier?: string;
}

/** The tools of each agent kind's sessions: the agent's, then those of the app's extensions the kind selects. */
export interface ToolCatalog {
  /** Tool `name` as a session of agent `kind` runs it; one neither has is unknown. */
  tool(kind: string, name: string): GatedTool;
  /** The tiers the tools of `kind`'s sessions carry: the tiers a session's rule may name. */
  tiers(kind: string): ReadonlySet<string>;
}

/** What an instance makes of the app's extensions when it opens. */
export interface AppExtensions {
  readonly catalog: ToolCatalog;
  /** The extensions to install in the instance's registry. */
  readonly installed: readonly Extension[];
  /**
   * What a session of agent `kind` selects: the app's extensions that select the kind, in the app's order, then the
   * agent's own extension, `own`, so its gate runs last and judges the arguments the call runs with.
   */
  selectionOf(kind: string, own: Extension): Extension[];
}

/**
 * Records that a call of an app tool parked on its own work, the commit before its park is: from then on, its sleep
 * is not the gate's, so it raises no question and takes no decision.
 */
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

/**
 * The arguments pi hands the chain of a call that an app hook rewrites: the model's, as the tool repairs and coerces
 * them, which no app hook has touched. The first app hook to rewrite the call memoizes them on its tool task, and the
 * gate checks a call decided before it parked against them, since the operator was asked about the model's arguments.
 */
export const MODEL_ARGS = "motoko.model.args";

/**
 * The tool hooks `registration`, the hook at `index` in app extension `extension`, as the instance installs them. What
 * their `beforeTool` returns becomes, in pi-durable's order (a `block`, then a `sleep`, then `arguments`):
 *
 * - nothing, or a `block`: itself;
 * - a `sleep`: a `block`. Only the gate parks a call before it runs: a call that sleeps there would show as a question,
 *   and `approve()` would decide it;
 * - `arguments`: the first the hook gave this call, memoized under the hook's extension and place (an extension may
 *   hook the tool task more than once), since pi-durable runs the chain again at every wake, registry change and
 *   decision. The first app hook to rewrite a call also memoizes the arguments it was handed (`MODEL_ARGS`);
 * - nothing, from a hook that gave `arguments` on an earlier run of the chain: those `arguments` still.
 */
function appToolHooks(extension: string, index: number, registration: HookRegistration): HookRegistration {
  // SAFETY: a registration for the tool task holds its hooks, as `hook(ToolTask, ...)` types them.
  const handlers = registration.handlers as Partial<ToolHooks>;
  const { beforeTool } = handlers;
  if (beforeTool === undefined) return registration;
  const memo = `motoko.args.${extension}.${index}`;
  const hooks: Partial<ToolHooks> = {
    ...handlers,
    async beforeTool(call, api, context) {
      const decision = await beforeTool.call(handlers, call, api, context);
      if (decision?.block !== undefined) return decision;
      if (decision?.sleep !== undefined) {
        return { block: `an app hook cannot make a call wait (app extension \`${extension}\`)` };
      }
      if (decision?.arguments !== undefined) {
        // Before the rewrite's own memo, so a held rewrite always has them. No hook before this one rewrote the call,
        // or its memo would hold them already.
        // SAFETY: pi-ai's JSON arguments differ from pi-durable's JSON only in typing their arrays readonly.
        await api.memo(MODEL_ARGS, call.arguments as JsonObject, context);
        return { arguments: await api.memo(memo, decision.arguments, context) };
      }
      const rewritten = await api.memo<JsonObject>(memo, context);
      return rewritten === undefined ? decision : { arguments: rewritten };
    },
  };
  return { ...registration, handlers: hooks };
}

/** App extension `extension` as the instance installs it, its tools' parks recorded and its tool hooks held. */
const installable = (extension: Extension): Extension => ({
  ...extension,
  ...(extension.tools !== undefined && { tools: extension.tools.map(withParksRecorded) }),
  ...(extension.hooks !== undefined && {
    hooks: extension.hooks.map((registration, index) =>
      registration.task === ToolTask.definition.name ? appToolHooks(extension.name, index, registration) : registration,
    ),
  }),
});

/**
 * The app's extensions `app` for the instance of `scope`, whose agent and sub-agents are `agents`. Throws a
 * `TypeError`, and the instance does not open, for an extension named like the runtime's (`runtime:` names) or like
 * another, a tool named like an agent's or like another extension's, or a wrap of an agent's tool: pi-durable runs the
 * last extension that provides or wraps a tool of a name, so any of those would run something else in an agent's
 * tool's place, past its ports.
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
  const installed = new Map(app.map(({ extension }) => [extension, installable(extension)]));

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
    installed: [...installed.values()],
    selectionOf: (kind, own) => [
      // SAFETY: every app extension was installed above.
      ...app.filter((entry) => selects(entry, kind)).map((entry) => installed.get(entry.extension)!),
      own,
    ],
  };
}
