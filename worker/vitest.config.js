import { defineConfig } from "vitest/config";

// The multi-case auth tests sign several RS256 tokens in a loop; under CPU load (the suite run
// alongside other work) they passed 5 s. A longer ceiling removes that flake without hiding a hang.
export default defineConfig({ test: { testTimeout: 20000 } });
