import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("the README", () => {
  it("shows the examples verbatim", async () => {
    const readme = await read("README.md");
    expect(readme).toContain(`\`\`\`ts\n${await read("examples/http.ts")}\`\`\``);
    expect(readme).toContain(`\`\`\`tsx\n${await read("examples/session.tsx")}\`\`\``);
  });
});
