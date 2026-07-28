import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.spec.ts", "apps/**/*.spec.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
