import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Every file here spawns a real Bun server subprocess (test-server.ts),
    // and some also spawn a stub provider. Run in parallel, they contend for
    // CPU and sockets and time out at startup — which reads as five security
    // tests failing at once, i.e. the most alarming possible false positive.
    // Serial is a few seconds slower and always tells the truth.
    fileParallelism: false,
  },
});
