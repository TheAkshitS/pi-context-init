import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        // Branches pin at 97.62: the untaken arms are enumerated in
        // docs/testing.md (defensive edges no honest test can take).
        branches: 97.62,
      },
    },
  },
});
