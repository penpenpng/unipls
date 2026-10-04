import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { chromium, firefox, webkit } from "playwright";

const browserTypes = { chromium, firefox, webkit };
const browserName = process.argv[2];
const browserType = browserTypes[browserName];
if (!browserType) {
  throw new Error(`Unknown browser: ${browserName}`);
}

const root = process.cwd();
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <script type="importmap">
          {"imports":{
            "unipls":"/node_modules/unipls/dist/index.mjs",
            "unipls/socket":"/node_modules/unipls/dist/socket.mjs",
            "unipls/drop-detectors":"/node_modules/unipls/dist/drop-detectors.mjs"
          }}
        </script>
        <script type="module" src="/browser-smoke.mjs"></script>`);
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    await stat(file);
    response.setHeader(
      "content-type",
      extname(file) === ".mjs" ? "text/javascript; charset=utf-8" : "application/octet-stream",
    );
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("HTTP server did not start");
}

const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  let rejectPageError;
  const pageError = new Promise((_, reject) => {
    rejectPageError = reject;
  });
  page.on("pageerror", rejectPageError);
  await Promise.race([
    (async () => {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.waitForFunction(() => globalThis.uniplsSmokeResult !== undefined);
    })(),
    pageError,
  ]);
  const result = await page.evaluate(() => globalThis.uniplsSmokeResult);
  if (result.checks !== 17) {
    throw new Error(`Expected 17 package checks, received ${result.checks}`);
  }
  console.log(`${browserName} unipls consumer: ${result.checks} checks passed`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}
