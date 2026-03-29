import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: {
      index: "src/index.ts",
      "hooks/check-docs": "src/hooks/check-docs.ts",
    },
    format: ["esm"],
    target: "node18",
    sourcemap: true,
  },
]);
