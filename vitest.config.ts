import { configDefaults, defineConfig } from "vitest/config";
import { tierPattern, tiers } from "./test/tiers.ts";

export default defineConfig({
  test: {
    projects: tiers.map((tier) => ({
      test: {
        name: tier.name,
        include: [tierPattern(tier)],
        exclude: [...configDefaults.exclude],
        // Every tier in the gate refuses anything that reaches past
        // loopback (docs/constraints/code-and-tests.md).
        setupFiles: tier.inGate ? ["test/offline.ts"] : [],
        testTimeout: tier.inGate ? 5_000 : 30_000,
      },
    })),
  },
});
