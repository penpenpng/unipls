import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let rejected = false;
try {
  await import("unipls/src/index.ts");
} catch (error) {
  rejected = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}
assert(rejected, "exportされていないdeep pathをimportできました。");

const manifest = fileURLToPath(import.meta.resolve("unipls/package.json"));
const packageDirectory = dirname(manifest);
let sourceIncluded = true;
try {
  await access(resolve(packageDirectory, "src"));
} catch {
  sourceIncluded = false;
}
assert(!sourceIncluded, "tarballへsource directoryが含まれています。");
await access(resolve(packageDirectory, "dist/index.mjs"));
await access(resolve(packageDirectory, "dist/reconnectors.mjs"));
await access(resolve(packageDirectory, "dist/drop-detectors.mjs"));
await access(resolve(packageDirectory, "dist/socket.mjs"));
