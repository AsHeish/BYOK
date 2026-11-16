import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readJson(path, label) {
  const text = await readFile(path, "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseVersion(version, label) {
  const match = versionPattern.exec(version);
  if (!match) {
    throw new Error(`${label} must use a numeric major.minor.patch version.`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (
    let componentIndex = 0;
    componentIndex < left.length;
    componentIndex += 1
  ) {
    if (left[componentIndex] !== right[componentIndex]) {
      return left[componentIndex] > right[componentIndex] ? 1 : -1;
    }
  }
  return 0;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function restoreFiles(files) {
  await Promise.all(
    files.map(({ path, text }) => writeFile(path, text, "utf8")),
  );
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const dryRun = argumentsList.includes("--dry-run");
  const requestedVersions = argumentsList.filter(
    (argument) => argument !== "--dry-run",
  );
  if (requestedVersions.length !== 1) {
    throw new Error(
      "Usage: npm run bump:build -- <patch|minor|major|x.y.z> [--dry-run]",
    );
  }

  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const manifestPath = resolve(root, "public/manifest.json");
  const [packageFile, lockFile, manifestFile] = await Promise.all([
    readJson(packagePath, "package.json"),
    readJson(lockPath, "package-lock.json"),
    readJson(manifestPath, "public/manifest.json"),
  ]);
  const packageData = packageFile.value;
  const lockData = lockFile.value;
  const manifestData = manifestFile.value;
  const currentVersion = packageData.version;
  const versionFields = [
    ["package.json", packageData.version],
    ["package-lock.json", lockData.version],
    [
      'package-lock.json packages[""].version',
      lockData.packages?.[""]?.version,
    ],
    ["public/manifest.json", manifestData.version],
  ];
  const mismatches = versionFields.filter(
    ([, version]) => version !== currentVersion,
  );
  if (mismatches.length > 0) {
    throw new Error(
      `Version fields do not match package.json (${currentVersion}): ${mismatches
        .map(([label, version]) => `${label}=${version ?? "missing"}`)
        .join(", ")}`,
    );
  }

  const currentParts = parseVersion(currentVersion, "Current version");
  const requestedVersion = requestedVersions[0];
  let nextVersion;
  if (requestedVersion === "patch") {
    nextVersion = `${currentParts[0]}.${currentParts[1]}.${currentParts[2] + 1}`;
  } else if (requestedVersion === "minor") {
    nextVersion = `${currentParts[0]}.${currentParts[1] + 1}.0`;
  } else if (requestedVersion === "major") {
    nextVersion = `${currentParts[0] + 1}.0.0`;
  } else {
    parseVersion(requestedVersion, "Requested version");
    nextVersion = requestedVersion;
  }
  if (
    compareVersions(parseVersion(nextVersion, "Next version"), currentParts) <=
    0
  ) {
    throw new Error(
      `Requested version ${nextVersion} must be greater than ${currentVersion}.`,
    );
  }

  const originalFiles = [
    { path: packagePath, text: packageFile.text },
    { path: lockPath, text: lockFile.text },
    { path: manifestPath, text: manifestFile.text },
  ];
  console.log(`Version: ${currentVersion} -> ${nextVersion}`);
  if (dryRun) {
    console.log("Dry run: version files will not be changed.");
  } else {
    packageData.version = nextVersion;
    lockData.version = nextVersion;
    lockData.packages[""].version = nextVersion;
    manifestData.version = nextVersion;
    try {
      await writeFile(packagePath, serializeJson(packageData), "utf8");
      await writeFile(lockPath, serializeJson(lockData), "utf8");
      await writeFile(manifestPath, serializeJson(manifestData), "utf8");
    } catch (error) {
      await restoreFiles(originalFiles);
      throw error;
    }
  }

  const npmExecPath = process.env.npm_execpath;
  const buildCommand = npmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const buildArguments = npmExecPath
    ? [npmExecPath, "run", "build"]
    : ["run", "build"];
  const buildResult = spawnSync(buildCommand, buildArguments, {
    cwd: root,
    stdio: "inherit",
    shell: !npmExecPath && process.platform === "win32",
    windowsHide: true,
  });

  if (buildResult.error || buildResult.status !== 0) {
    if (!dryRun) {
      await restoreFiles(originalFiles);
      console.error("Build failed; version files were restored.");
    }
    if (buildResult.error) {
      throw buildResult.error;
    }
    process.exitCode = buildResult.status ?? 1;
    return;
  }
  console.log(`Build succeeded for ${nextVersion}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
