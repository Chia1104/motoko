import { describe, expect, it } from "vite-plus/test";

import client from "../examples/browser/notes-client.ts?raw";
import session from "../examples/browser/notes-session.tsx?raw";
import example from "../examples/notes-agent.ts?raw";
import readme from "../README.md?raw";

describe("the README", () => {
  it("shows the examples verbatim", () => {
    expect(readme).toContain(`\`\`\`ts\n${example}\`\`\``);
    expect(readme).toContain(`\`\`\`tsx\n${session}\`\`\``);
    expect(readme).toContain(`\`\`\`ts\n${client}\`\`\``);
  });
});
