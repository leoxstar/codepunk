import js from "@eslint/js";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const NODE_GLOBALS = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  performance: "readonly",
  process: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "tests/fixtures/**",
      ".worktrees/**",
      "coverage/**",
      ".test-dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts"],
    plugins: {
      "import-x": importX,
    },
    languageOptions: {
      globals: NODE_GLOBALS,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-control-regex": "off",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-useless-assignment": "off",
      "no-var": "error",
      "prefer-const": "error",
      "preserve-caught-error": "off",
      "import-x/no-duplicates": "error",
      "import-x/no-self-import": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false, arguments: false } },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "codepunk-protocol/*",
                "codepunk-core/*",
                "codepunk-cli/*",
              ],
              message:
                "Import workspace packages through their public root entrypoint only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/protocol/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "codepunk-core",
              message:
                "codepunk-protocol (layer 0) cannot import codepunk-core.",
            },
            {
              name: "codepunk-cli",
              message:
                "codepunk-protocol (layer 0) cannot import codepunk-cli.",
            },
          ],
          patterns: [
            {
              group: [
                "codepunk-protocol/*",
                "codepunk-core/*",
                "codepunk-cli/*",
              ],
              message:
                "Import workspace packages through their public root entrypoint only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "codepunk-cli",
              message: "codepunk-core (layer 1) cannot import codepunk-cli.",
            },
          ],
          patterns: [
            {
              group: [
                "codepunk-protocol/*",
                "codepunk-core/*",
                "codepunk-cli/*",
              ],
              message:
                "Import workspace packages through their public root entrypoint only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "packages/cli/build.mjs",
      "eslint.config.mjs",
      "eval/**/*.mjs",
      "tests/**/*.mjs",
    ],
    languageOptions: {
      globals: NODE_GLOBALS,
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-control-regex": "off",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-regex-spaces": "off",
      "no-useless-assignment": "off",
      "no-var": "error",
      "prefer-const": "error",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
