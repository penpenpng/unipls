import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.spec.ts"],
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
    entry: ["src/index.ts", "src/socket.ts", "src/browser.ts"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    format: ["esm"],
  },
});
