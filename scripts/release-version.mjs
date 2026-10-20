import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unlike $, this end assertion also rejects a final newline or line separator.
const releaseTagPattern =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9][0-9]*))?(?![\s\S])/u;

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !releaseTagPattern.test(tag)) {
    throw new Error(
      "RELEASE_TAG must be vMAJOR.MINOR.PATCH, optionally followed by -alpha.N, -beta.N or -rc.N; numeric parts must not have leading zeros",
    );
  }
  return tag.slice(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireVersion(value, label) {
  if (!isObject(value) || typeof value.version !== "string") {
    throw new Error(`${label} must be an object with a string version`);
  }
}

async function readPackageFile(name) {
  const path = resolve(process.cwd(), name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      `${name} must be a regular, non-symlink file with a single hard link in the current directory`,
    );
  }
  try {
    return { path, document: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    throw new Error(`Cannot read ${name}: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error(
      "Usage: RELEASE_TAG=vX.Y.Z node scripts/release-version.mjs [--check]",
    );
  }
  const version = versionFromTag(process.env.RELEASE_TAG);
  if (args[0] !== "--check") {
    // Read and validate both documents before changing either file.
    const manifest = await readPackageFile("package.json");
    const lock = await readPackageFile("package-lock.json");
    requireVersion(manifest.document, "package.json");
    requireVersion(lock.document, "package-lock.json");
    if (!isObject(lock.document.packages)) {
      throw new Error("package-lock.json must contain a packages object");
    }
    requireVersion(
      lock.document.packages[""],
      'package-lock.json packages[""]',
    );

    manifest.document.version = version;
    lock.document.version = version;
    lock.document.packages[""].version = version;
    const manifestText = `${JSON.stringify(manifest.document, null, 2)}\n`;
    const lockText = `${JSON.stringify(lock.document, null, 2)}\n`;
    await writeFile(manifest.path, manifestText, "utf8");
    await writeFile(lock.path, lockText, "utf8");
  }
  process.stdout.write(`${version}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
