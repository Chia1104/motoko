import { baseConfig } from "@chiastack/oxlint/base";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 120,
    sortPackageJson: false,
    ignorePatterns: [
      "pnpm-lock.yaml",
      "coverage",
      ".vscode",
      ".idea",
      // drizzle-kit writes the migrations, and the bench writes its results.
      "packages/store-postgres/migrations/**",
      "packages/store-postgres/bench/results/**",
      "packages/store-mysql/migrations/**",
    ],
    sortImports: {
      groups: [["builtin"], ["external"], ["workspace"], ["internal"], ["parent"], ["sibling"], ["index"], "unknown"],
      customGroups: [{ groupName: "workspace", elementNamePattern: ["@chia1104/motoko-*", "@chia1104/motoko-*/**"] }],
    },
    overrides: [
      {
        // The READMEs' code blocks are laid out by hand for reading.
        files: ["**/*.md"],
        options: { embeddedLanguageFormatting: "off" },
      },
    ],
  },
  lint: {
    extends: [baseConfig],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    ignorePatterns: [
      "**/*.d.ts",
      "dist/**",
      "node_modules/**",
      "packages/store-postgres/migrations/**",
      "packages/store-mysql/migrations/**",
    ],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // The base preset turns the correctness category off; an unawaited commit or lease call must not slip through.
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      // Dependencies mark what their next version drops; a use of it is a lint error, not a surprise at upgrade.
      "typescript/no-deprecated": "error",
      "oxc/no-accumulating-spread": "error",
      // A library reports through the app's `onReport`, never to the app's terminal.
      "no-console": "error",
    },
    overrides: [
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        rules: {
          // TypeScript intentionally allows a value and a type to share one name.
          "no-redeclare": "off",
        },
      },
      {
        // The wire and the core run anywhere a host runs them: a browser, Electron or a Durable Object.
        files: ["packages/wire/src/**", "packages/core/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message:
                    "@chia1104/motoko-wire and @chia1104/motoko-core are runtime-agnostic: reach Node through a host.",
                },
              ],
            },
          ],
        },
      },
      {
        // The client runs in a browser.
        files: ["packages/client/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { patterns: [{ group: ["node:*"], message: "@chia1104/motoko-client runs in a browser." }] },
          ],
        },
      },
      {
        // The command-line tool, and the examples, bench and scripts that print what they show.
        files: [
          "packages/store-postgres/src/cli.ts",
          "packages/store-mysql/src/cli.ts",
          "**/examples/**",
          "**/bench/**",
          "**/scripts/**",
        ],
        rules: { "no-console": "off" },
      },
    ],
  },
  staged: {
    "*.{js,jsx,cjs,mjs,ts,mts,tsx,json,md}": "vp fmt --no-error-on-unmatched-pattern",
  },
  run: {
    cache: true,
  },
});
