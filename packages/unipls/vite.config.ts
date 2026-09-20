import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/contract/**/*.spec.ts", "tests/unit/**/*.test.ts"],
    exclude: ["tests/reference/**"],
    // Transitional until Task 1 adds the first normative tests.
    passWithNoTests: true,
  },
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    format: ["esm"],
  },
});
