// Finding, installing and loading versions of the youtubei.js package at runtime.
// Also a CLI used by the Dockerfile to bake in a baseline version:
//   node src/ytjs-package.js install <dir>

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const PKG = "youtubei.js";
const run = promisify(execFile);
const EXACT = /^\d+\.\d+\.\d+$/;

export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function validateSpec(spec) {
  if (!(spec === "latest" || /^\d+$/.test(spec) || EXACT.test(spec))) {
    throw new Error(`Unsupported YTJS_VERSION "${spec}": use "latest", a major version like "18", or an exact version like "18.3.0"`);
  }
}

export const isExactSpec = (spec) => EXACT.test(spec);

/**
 * Pick the version to run from an npm registry document.
 * Stable releases only, not deprecated, published before cutoffMs (exact pins skip the age rule).
 */
export function pickVersion(doc, spec, cutoffMs) {
  validateSpec(spec);
  if (isExactSpec(spec)) {
    if (!doc.versions?.[spec]) throw new Error(`${PKG}@${spec} does not exist`);
    return spec;
  }
  const latest = doc["dist-tags"]?.latest;
  return (
    Object.keys(doc.versions ?? {})
      .filter((v) => EXACT.test(v) && !doc.versions[v].deprecated)
      .filter((v) => (spec === "latest" ? !latest || compareVersions(v, latest) <= 0 : v.split(".")[0] === spec))
      .filter((v) => Date.parse(doc.time?.[v]) <= cutoffMs)
      .sort(compareVersions)
      .at(-1) ?? null
  );
}

export async function resolveTargetVersion(spec, minAgeHours) {
  const res = await fetch(`https://registry.npmjs.org/${PKG}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
  return pickVersion(await res.json(), spec, Date.now() - minAgeHours * 3600_000);
}

/** Install PKG@version into dir (atomically: into a temp dir, then rename). */
export async function installVersion(version, dir, { cacheDir = null, beforeMs = null } = {}) {
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "ytjs-runtime", private: true }));
  const args = ["install", `${PKG}@${version}`, "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev", "--loglevel=error"];
  // Hold transitive dependencies to the same minimum release age.
  if (beforeMs) args.push(`--before=${new Date(beforeMs).toISOString()}`);
  try {
    await run("npm", args, {
      cwd: tmp,
      env: { ...process.env, ...(cacheDir ? { npm_config_cache: cacheDir } : {}) },
      timeout: 5 * 60_000,
    });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(`npm install ${PKG}@${version} failed: ${err.stderr?.trim() || err.message}`);
  }
}

export async function installedVersion(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "node_modules", PKG, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** Import PKG from a specific install dir. Different dirs load as independent module instances. */
export async function loadModule(dir) {
  const entry = createRequire(path.join(path.resolve(dir), "package.json")).resolve(PKG);
  return import(pathToFileURL(entry).href);
}

// CLI: bake a baseline version into the image at build time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "install" || !dir) {
    console.error("usage: node src/ytjs-package.js install <dir>");
    process.exit(1);
  }
  const spec = process.env.YTJS_VERSION || "latest";
  const age = Number(process.env.YTJS_MIN_RELEASE_AGE_HOURS ?? 24);
  const version = await resolveTargetVersion(spec, age);
  if (!version) throw new Error(`No ${PKG} version matches "${spec}" and is at least ${age}h old`);
  await installVersion(version, path.resolve(dir), { beforeMs: isExactSpec(spec) ? null : Date.now() - age * 3600_000 });
  console.log(`installed ${PKG}@${version} into ${dir}`);
}
