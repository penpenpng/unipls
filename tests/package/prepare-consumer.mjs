import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const [, , tarballArgument, destinationArgument] = process.argv;
if (!tarballArgument || !destinationArgument) {
  throw new Error("Usage: node prepare-consumer.mjs <tarball> <destination>");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(scriptDirectory, "fixture");
const tarball = resolve(tarballArgument);
const destination = resolve(destinationArgument);

await mkdir(destination, { recursive: true });
await cp(fixtureSource, destination, { recursive: true });
await writeFile(
  resolve(destination, "package.json"),
  `${JSON.stringify({ name: "unipls-consumer", private: true, type: "module" }, null, 2)}\n`,
);

await run("npm", [
  "install",
  "--ignore-scripts",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
  tarball,
]);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: destination, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} failed: code=${code}, signal=${signal}`));
      }
    });
  });
}
