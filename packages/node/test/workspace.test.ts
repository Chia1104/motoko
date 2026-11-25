import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const packages = fileURLToPath(new URL("../../", import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function importsOf(pkg: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const file of await sources(join(packages, pkg, "src"))) {
    const text = await readFile(file, "utf8");
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]!);
    found.set(file, specifiers);
  }
  return found;
}

describe("package boundaries", () => {
  it("wire imports nothing but zod and its own modules", async () => {
    for (const [file, specifiers] of await importsOf("wire")) {
      for (const specifier of specifiers) {
        expect(specifier === "zod" || specifier.startsWith("./"), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("the client imports nothing but wire, React for its hook, and its own modules", async () => {
    for (const [file, specifiers] of await importsOf("client")) {
      const allowed = (specifier: string) =>
        specifier === "@chia1104/motoko-wire" ||
        specifier === "@chia1104/motoko-wire/socket" ||
        specifier.startsWith("./") ||
        (specifier === "react" && file.endsWith("react.ts"));
      for (const specifier of specifiers) expect(allowed(specifier), `${file} imports ${specifier}`).toBe(true);
      const text = await readFile(file, "utf8");
      expect(/\b(process|Buffer|__dirname|require)\b[.(]/.test(text), `${file} uses a Node global`).toBe(false);
    }
  });

  it("core uses no Node built-ins", async () => {
    for (const [file, specifiers] of await importsOf("core")) {
      for (const specifier of specifiers) {
        expect(specifier.startsWith("node:") || specifier.includes("/node"), `${file} imports ${specifier}`).toBe(
          false,
        );
      }
      const text = await readFile(file, "utf8");
      expect(/\b(process|Buffer|__dirname|require)\b[.(]/.test(text), `${file} uses a Node global`).toBe(false);
    }
  });

  it("core re-exports nothing of pi: the app imports pi itself", async () => {
    const manifest = JSON.parse(await readFile(join(packages, "core", "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual([".", "./testing", "./store", "./store/testing", "./sqlite"]);
    for (const [file] of await importsOf("core")) {
      const text = await readFile(file, "utf8");
      expect(/^export\s[^;]*from\s+"@earendil-works\//m.test(text), `${file} re-exports pi`).toBe(false);
    }
  });

  it("every package using pi takes it as a peer at ~1.6.0", async () => {
    for (const pkg of ["core", "node"]) {
      const manifest = JSON.parse(await readFile(join(packages, pkg, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const pi = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@earendil-works/"));
      expect(pi, `${pkg} depends on pi directly`).toEqual([]);
      for (const name of [
        "@earendil-works/chord",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-durable",
        "@earendil-works/pi-schema",
      ]) {
        expect(manifest.peerDependencies?.[name], `${pkg} peer ${name}`).toBe("~1.6.0");
      }
    }
  });
});

describe("README examples", () => {
  for (const [pkg, example] of [
    ["wire", "client.ts"],
    ["core", "notes-agent.ts"],
    ["core", "per-caller.ts"],
    ["node", "server.ts"],
  ] as const) {
    it(`${pkg}'s README shows examples/${example} verbatim`, async () => {
      const readme = await readFile(join(packages, pkg, "README.md"), "utf8");
      const code = await readFile(join(packages, pkg, "examples", example), "utf8");
      expect(readme).toContain(`\`\`\`ts\n${code}\`\`\``);
    });
  }
});
