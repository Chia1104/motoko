import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const name = manifest.name;
// A workspace link resolves to its real path, outside node_modules.
const runtime = new URL("..", import.meta.resolve("@chia1104/motoko-core")).href;

function loaded(specifier) {
  const program = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); seen.push(result.url); return result; } });
    const module = await import(${JSON.stringify(specifier)});
    console.log(JSON.stringify({ exports: Object.keys(module).sort(), seen }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: fileURLToPath(root) });
  return JSON.parse(out.toString());
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

for (const subpath of [".", "./schema", "./pglite"]) {
  const specifier = subpath === "." ? name : `${name}${subpath.slice(1)}`;
  const { exports, seen } = loaded(specifier);
  const own = seen.filter((url) => url.startsWith(root.href) && !url.includes("/node_modules/"));
  check(
    own.every((url) => url.includes("/dist/")),
    `${specifier} resolves to dist (${own.map((url) => url.slice(root.href.length)).join(", ")})`,
  );
  check(exports.length > 0, `${specifier} exports ${exports.join(", ")}`);
  const pglite = seen.filter((url) => url.includes("@electric-sql/pglite") || url.includes("drizzle-orm/pglite"));
  if (subpath === "./pglite") check(pglite.length > 0, `${specifier} loads PGlite`);
  else check(pglite.length === 0, `${specifier} loads no PGlite`);
  if (subpath === "./schema") {
    const drivers = seen.filter(
      (url) => /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(pg|pg-pool)\//.test(url) || url.startsWith(runtime),
    );
    check(drivers.length === 0, `${specifier} loads no driver and no runtime`);
  }
}

const [first] = readdirSync(new URL("migrations/", root)).sort();
const sql = new URL(`migrations/${first}/migration.sql`, root);
const resolvedSql = execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `console.log(import.meta.resolve(${JSON.stringify(`${name}/migrations/${first}/migration.sql`)}))`,
  ],
  { cwd: fileURLToPath(root) },
)
  .toString()
  .trim();
check(resolvedSql === sql.href, `${name}/migrations/* resolves (${resolvedSql.slice(root.href.length)})`);
check(
  manifest.files.includes("migrations") && manifest.files.includes("dist"),
  `files ships ${manifest.files.join(", ")}`,
);

for (const [command, path] of Object.entries(manifest.bin)) {
  const file = new URL(path, root);
  let executable = true;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    executable = false;
  }
  const shebang = readFileSync(file, "utf8").startsWith("#!/usr/bin/env node\n");
  check(executable && shebang, `bin ${command} -> ${path} is executable with a node shebang`);
  let usage = "";
  try {
    execFileSync(process.execPath, [fileURLToPath(file)], { env: { PATH: process.env.PATH }, stdio: "pipe" });
  } catch (error) {
    usage = `${error.status}: ${error.stderr}`;
  }
  check(usage.startsWith("2: No database"), `bin ${command} without a database exits 2 (${usage.split("\n")[0]})`);
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
