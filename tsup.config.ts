import { defineConfig } from "tsup";
import packageJson from "./package.json";

const define = { __CODUMENT_BUILD_VERSION__: JSON.stringify(packageJson.version) };

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    define,
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
    define,
    sourcemap: true,
  },
]);
