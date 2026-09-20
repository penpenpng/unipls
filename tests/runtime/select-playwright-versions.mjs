let input = "";

// 標準入力から registry の version 一覧を取得します。
for await (const chunk of process.stdin) {
  input += chunk;
}

// 安定版の semantic version だけを新しい順に並べます。
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

// 最新2系統の release line から、それぞれ最新 release を選びます。
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

// CI matrix を縮小せず、不完全な registry data を拒否します。
if (selectedVersions.length !== 2) {
  throw new Error("Could not resolve the latest two stable Playwright release lines");
}

// GitHub Actions で利用できる matrix 値を出力します。
process.stdout.write(`versions=${JSON.stringify(selectedVersions)}\n`);
