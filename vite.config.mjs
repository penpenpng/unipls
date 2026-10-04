import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: ["@stylistic/eslint-plugin"],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      curly: ["error", "all"],
      "eslint/no-nested-ternary": "error",
      "unicorn/prefer-add-event-listener": "off",
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: "*", next: ["if", "for", "switch"] },
        { blankLine: "always", prev: ["if", "for", "switch"], next: "*" },
        { blankLine: "any", prev: "if", next: "if" },
        { blankLine: "any", prev: "for", next: "for" },
        { blankLine: "any", prev: "switch", next: "switch" },
        {
          blankLine: "always",
          prev: "*",
          next: { selector: 'ExpressionStatement[expression.type="AssignmentExpression"]' },
        },
        {
          blankLine: "always",
          prev: { selector: 'ExpressionStatement[expression.type="AssignmentExpression"]' },
          next: "*",
        },
        {
          blankLine: "any",
          prev: { selector: 'ExpressionStatement[expression.type="AssignmentExpression"]' },
          next: { selector: 'ExpressionStatement[expression.type="AssignmentExpression"]' },
        },
      ],
    },
  },
  fmt: {
    sortImports: true,
  },
  test: {
    projects: [
      {
        test: {
          name: "spec",
          include: ["tests/spec/**/*.spec.ts"],
        },
      },
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
    ],
  },
  pack: {
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    entry: ["src/index.ts", "src/reconnectors.ts", "src/drop-detectors.ts", "src/socket.ts"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    format: ["esm"],
  },
});
