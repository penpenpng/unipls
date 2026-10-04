import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "../..");
const workspace = await mkdtemp(resolve(tmpdir(), "unipls-consumer-"));
const artifacts = resolve(workspace, "artifacts");
const consumer = resolve(workspace, "consumer");

try {
  await mkdir(artifacts);
  await run("npm", ["pack", "--pack-destination", artifacts, packageDirectory], packageDirectory);
  const tarballs = (await readdir(artifacts)).filter((file) => file.endsWith(".tgz"));

  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball, received ${tarballs.length}`);
  }

  const tarball = resolve(artifacts, tarballs[0]);

  await run(process.execPath, [
    resolve(scriptDirectory, "prepare-consumer.mjs"),
    tarball,
    consumer,
  ]);
  await run(process.execPath, [resolve(consumer, "run-smoke.mjs")], consumer);
  await run(process.execPath, [resolve(consumer, "verify-node-package.mjs")], consumer);
  await run(
    process.execPath,
    [resolve(packageDirectory, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    consumer,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function run(command, args, cwd = packageDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });

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
