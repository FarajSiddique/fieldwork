import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["**/node_modules/**", "bench/.data/**", "bench/cache/**", "bench/results/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
]);
