let input = "";

// Collect the registry version list from standard input.
for await (const chunk of process.stdin) {
  input += chunk;
}

// Retain stable semantic versions and sort newest first.
const versions = JSON.parse(input);
const stableVersions = versions
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  .map((version) => ({
    version,
    parts: version.split(".").map(Number),
  }))
  .sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = right.parts[index] - left.parts[index];
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  });

// Select the newest release from each of the latest two release lines.
const selectedVersions = [];
const selectedLines = new Set();

for (const candidate of stableVersions) {
  const releaseLine = candidate.parts.slice(0, 2).join(".");
  if (selectedLines.has(releaseLine)) {
    continue;
  }

  selectedLines.add(releaseLine);
  selectedVersions.push(candidate.version);
  if (selectedVersions.length === 2) {
    break;
  }
}

// Reject incomplete registry data instead of weakening the CI matrix.
if (selectedVersions.length !== 2) {
  throw new Error(
    "Could not resolve the latest two stable Playwright release lines",
  );
}

// Emit the GitHub Actions-compatible matrix value.
process.stdout.write(`versions=${JSON.stringify(selectedVersions)}\n`);
