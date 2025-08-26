import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ts.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: { globals: globals.browser },
  },
  {
    ignores: [
      "eslint.config.mjs",
      "prettier.config.mjs",
      "dist/**",
      "node_modules/**",
    ],
  },
]);
