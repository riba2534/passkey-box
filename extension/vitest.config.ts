import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PKB_DEFAULT_SERVER_URL__: JSON.stringify(""),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
