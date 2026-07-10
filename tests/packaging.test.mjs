import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packFiles() {
  const tempDir = makeTempDir("opencode-plugin-pack-");
  const packageDir = path.join(tempDir, "package");
  const cacheDir = path.join(tempDir, "npm-cache");

  try {
    fs.cpSync(ROOT, packageDir, {
      recursive: true,
      filter(source) {
        const relativePath = path.relative(ROOT, source);
        return ![".claude", ".git", "node_modules"].includes(relativePath);
      }
    });
    fs.mkdirSync(path.join(packageDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, ".claude", "settings.local.json"), "{}\n");

    const result = run("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: cacheDir
      }
    });

    if (result.error?.code === "ENOENT") {
      return null;
    }

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout)[0].files.map((file) => file.path);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("npm pack ships only the plugin artifact", (t) => {
  const files = packFiles();

  if (!files) {
    t.skip("npm pack is unavailable");
    return;
  }

  assert.equal(files.includes(".claude/settings.local.json"), false);
  assert.equal(files.some((file) => file.startsWith("tests/")), false);
  assert.equal(files.includes("plugins/opencode/.claude-plugin/plugin.json"), true);
  assert.equal(files.includes("plugins/opencode/hooks/hooks.json"), true);
  assert.equal(files.includes("plugins/opencode/prompts/stop-review-gate.md"), true);
  assert.equal(files.includes("plugins/opencode/schemas/review-output.schema.json"), true);
  assert.equal(files.includes("plugins/opencode/scripts/opencode-companion.mjs"), true);
});
