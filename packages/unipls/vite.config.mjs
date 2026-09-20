import { defineConfig } from "vite-plus";

const referenceTests = ["tests/reference/**"];

export default defineConfig({
  test: {
    exclude: referenceTests,
    projects: [
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.spec.ts"],
          exclude: referenceTests,
        },
      },
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: referenceTests,
        },
      },
    ],
    coverage: {
      exclude: referenceTests,
    },
  },
  pack: {
    entry: ["src/index.ts", "src/socket.ts", "src/browser.ts"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    format: ["esm"],
  },
});
