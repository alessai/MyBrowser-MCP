import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: [".."],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
