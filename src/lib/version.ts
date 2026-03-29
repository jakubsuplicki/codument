import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./scaffold.js";

const pkg = JSON.parse(
  readFileSync(join(packageRoot(), "package.json"), "utf-8"),
);

export const version: string = pkg.version;
