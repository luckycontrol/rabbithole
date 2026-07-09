import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(rootDir, "website");
const websiteOut = path.join(websiteDir, "out");
const webDist = path.join(rootDir, "web/dist");
const publishDir = path.join(rootDir, "publish");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

run(process.execPath, ["build.mjs"], { cwd: rootDir });

if (!(await exists(path.join(websiteDir, "node_modules", "next")))) {
  run(npmBin, ["ci"], { cwd: websiteDir });
}

await fs.rm(websiteOut, { recursive: true, force: true });
run(npmBin, ["run", "build"], { cwd: websiteDir });

await assertFile(path.join(websiteOut, "index.html"), "website/out/index.html");
await assertFile(path.join(webDist, "index.html"), "web/dist/index.html");

await fs.rm(publishDir, { recursive: true, force: true });
await fs.mkdir(publishDir, { recursive: true });
await copyContents(websiteOut, publishDir);
await fs.mkdir(path.join(publishDir, "app"), { recursive: true });
await copyContents(webDist, path.join(publishDir, "app"));
await prepareAppSubpath(path.join(publishDir, "app"));

await assertFile(path.join(publishDir, "index.html"), "publish/index.html");
await assertFile(path.join(publishDir, "app/index.html"), "publish/app/index.html");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
}

async function copyContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function prepareAppSubpath(appDir) {
  const indexPath = path.join(appDir, "index.html");
  let html = await fs.readFile(indexPath, "utf8");
  html = replaceOnce(html, 'href="./styles.css"', 'href="/app/styles.css"');
  html = replaceOnce(html, 'src="./dompurify.js"', 'src="/app/dompurify.js"');
  html = replaceOnce(html, 'src="./frozen-source.js"', 'src="/app/frozen-source.js"');
  html = replaceOnce(html, 'src="./app.js"', 'src="/app/app.js"');
  html = replaceOnce(
    html,
    '<script type="module" src="/app/app.js"></script>',
    '<script src="/app/asset-base.js"></script>\n<script type="module" src="/app/app.js"></script>'
  );
  await fs.writeFile(indexPath, html, "utf8");
  await fs.writeFile(path.join(appDir, "asset-base.js"), 'window.__RABBITHOLE_WEB_ASSET_BASE__="/app/";\n', "utf8");
}

function replaceOnce(source, search, replacement) {
  if (!source.includes(search)) {
    throw new Error(`Expected app index.html to include ${search}`);
  }
  return source.replace(search, replacement);
}

async function assertFile(file, label) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(`Expected ${label} to exist after build.`);
}
