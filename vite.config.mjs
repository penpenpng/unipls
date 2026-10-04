import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      curly: ["error", "all"],
      "unicorn/prefer-add-event-listener": "off",
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
