import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/**
 * NodeNext TypeScript writes imports as `./foo.js` while the source is
 * `./foo.ts`. Vite doesn't resolve that by default, so map it back for tests.
 */
const tsResolver: Plugin = {
  name: "tgdb-ts-resolver",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (importer && source.startsWith(".") && source.endsWith(".js")) {
      const candidate = `${source.slice(0, -3)}.ts`;
      const resolved = await this.resolve(candidate, importer, { ...options, skipSelf: true });
      if (resolved) return resolved;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [tsResolver],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
