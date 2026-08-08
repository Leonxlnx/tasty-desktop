import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLicenseRootEntries } from "./check-third-party-licenses.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps", "desktop", "src-tauri", "target", "bundle-assets");
const bundledNodeVersion = "v22.22.2";
const bundledNodeSha256 = "ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3";
const bundledNodeLicense = join(root, "third_party", "node", "v22.22.2", "LICENSE.txt");
const bundledNodeLicenseSha256 =
  "8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576";
const licenseSource = join(root, "third_party", "licenses");
const bundledLicenses = resolve(output, "third-party-licenses");
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

export async function recreateBundleAssets(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

export async function copyReviewedLicenses(source, destination) {
  assertLicenseRootEntries(await readdir(source, { withFileTypes: true }));
  await cp(source, destination, { recursive: true });
}

async function prepareBundle() {
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== bundledNodeVersion) {
    throw new Error(
      `Windows bundles require Node.js ${bundledNodeVersion} x64; found ${process.version} ${process.platform}-${process.arch}.`,
    );
  }

  if ((await sha256(process.execPath)) !== bundledNodeSha256) {
    throw new Error(`Node.js ${bundledNodeVersion} executable does not match the official Windows x64 archive.`);
  }

  if ((await sha256(bundledNodeLicense)) !== bundledNodeLicenseSha256) {
    throw new Error(`Node.js ${bundledNodeVersion} license does not match the official distribution.`);
  }

  await recreateBundleAssets(output);
  await Promise.all([
    copyFile(process.execPath, join(output, "node.exe")),
    copyFile(bundledNodeLicense, join(output, "NODE-LICENSE.txt")),
    copyFile(join(root, "LICENSE"), join(output, "LICENSE.txt")),
    copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md")),
    copyReviewedLicenses(licenseSource, bundledLicenses),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareBundle();
