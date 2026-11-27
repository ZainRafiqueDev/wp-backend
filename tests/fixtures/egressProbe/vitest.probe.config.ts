import { defineConfig } from "vitest/config"

import base from "../../../vitest.config"

// Runs only the egress probe, with the normal suite's env and setup file.
// (Not mergeConfig: it would concatenate `include` with the base suite's.)
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/fixtures/egressProbe/egressProbe.probe.ts"],
  },
})
