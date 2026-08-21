import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_STATIC_ASSET_SIZE = 25 * 1024 * 1024;
const PART_SIZE = 20 * 1024 * 1024;
const RELEASE_VERSION = "0.1.3";
const RELEASE_FILE_NAME = `panelshift-chrome-extension-v${RELEASE_VERSION}.zip`;
const SOURCE_ARCHIVE = join(ROOT, "artifacts", "panelshift-chrome-extension.zip");
const MANIFEST_PATH = join(ROOT, "panelshift-release.json");
const PUBLIC_DOWNLOADS_DIR = join(ROOT, "public", "downloads");
const PUBLIC_PARTS_DIR = join(PUBLIC_DOWNLOADS_DIR, "parts");
const PUBLIC_MANIFEST_PATH = join(PUBLIC_DOWNLOADS_DIR, "panelshift-release.json");
const OCR_MODELS_SOURCE_DIR = join(ROOT, "extension", "public", "models");
const OCR_MODELS_PUBLIC_DIR = join(ROOT, "public", "ocr-models");
const VERIFY_ONLY = process.argv.includes("--verify");

if (PART_SIZE >= MAX_STATIC_ASSET_SIZE) {
  throw new Error("Download part size must stay below Cloudflare's 25 MiB asset limit");
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex");
}

async function generateReleaseManifest() {
  const sourceStats = await stat(SOURCE_ARCHIVE);
  if (!sourceStats.isFile() || sourceStats.size === 0) {
    throw new Error(`Canonical extension archive is empty: ${relative(ROOT, SOURCE_ARCHIVE)}`);
  }

  await rm(PUBLIC_PARTS_DIR, { recursive: true, force: true });
  await mkdir(PUBLIC_PARTS_DIR, { recursive: true });

  const source = await open(SOURCE_ARCHIVE, "r");
  const archiveHash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const parts = [];
  let sourceOffset = 0;

  try {
    while (sourceOffset < sourceStats.size) {
      const partNumber = parts.length + 1;
      const partName = `${RELEASE_FILE_NAME}.part-${String(partNumber).padStart(3, "0")}`;
      const partPath = join(PUBLIC_PARTS_DIR, partName);
      const part = await open(partPath, "w");
      const partHash = createHash("sha256");
      const expectedPartSize = Math.min(PART_SIZE, sourceStats.size - sourceOffset);
      let partBytes = 0;

      try {
        while (partBytes < expectedPartSize) {
          const bytesToRead = Math.min(buffer.length, expectedPartSize - partBytes);
          const { bytesRead } = await source.read(
            buffer,
            0,
            bytesToRead,
            sourceOffset,
          );

          if (bytesRead === 0) {
            throw new Error(`Canonical extension archive ended at byte ${sourceOffset}`);
          }

          const bytes = buffer.subarray(0, bytesRead);
          await part.write(bytes);
          archiveHash.update(bytes);
          partHash.update(bytes);
          partBytes += bytesRead;
          sourceOffset += bytesRead;
        }
      } finally {
        await part.close();
      }

      if (partBytes >= MAX_STATIC_ASSET_SIZE) {
        throw new Error(`${partName} is too large for a Cloudflare static asset`);
      }

      parts.push({
        path: `/downloads/parts/${partName}`,
        size: partBytes,
        sha256: partHash.digest("hex"),
      });
    }
  } finally {
    await source.close();
  }

  return {
    schemaVersion: 1,
    version: RELEASE_VERSION,
    downloadPath: `/downloads/${RELEASE_FILE_NAME}`,
    fileName: RELEASE_FILE_NAME,
    contentType: "application/zip",
    totalSize: sourceStats.size,
    sha256: archiveHash.digest("hex"),
    partSize: PART_SIZE,
    parts,
  };
}

function assertReleaseManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported release manifest schema");
  if (manifest.version !== RELEASE_VERSION) throw new Error("Release manifest version is stale");
  if (manifest.fileName !== RELEASE_FILE_NAME) throw new Error("Release manifest filename is stale");
  if (manifest.downloadPath !== `/downloads/${RELEASE_FILE_NAME}`) {
    throw new Error("Release manifest download path is stale");
  }
  if (manifest.contentType !== "application/zip") throw new Error("Unexpected release content type");
  if (!Number.isSafeInteger(manifest.totalSize) || manifest.totalSize <= 0) {
    throw new Error("Release manifest has an invalid total size");
  }
  if (manifest.partSize !== PART_SIZE || manifest.partSize >= MAX_STATIC_ASSET_SIZE) {
    throw new Error("Release manifest has an invalid part size");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("Release manifest has an invalid SHA-256 digest");
  }
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new Error("Release manifest has no download parts");
  }
}

async function validatePreparedRelease(manifest) {
  assertReleaseManifest(manifest);

  const expectedPartNames = manifest.parts.map((part) => part.path.split("/").at(-1));
  const preparedPartNames = (await readdir(PUBLIC_PARTS_DIR)).sort();
  if (JSON.stringify(preparedPartNames) !== JSON.stringify(expectedPartNames)) {
    throw new Error("Prepared download part list does not match the release manifest");
  }

  const combinedHash = createHash("sha256");
  let totalSize = 0;

  for (const [index, part] of manifest.parts.entries()) {
    const expectedName = `${RELEASE_FILE_NAME}.part-${String(index + 1).padStart(3, "0")}`;
    const expectedPath = `/downloads/parts/${expectedName}`;
    if (part.path !== expectedPath) throw new Error(`Unexpected download part path: ${part.path}`);
    if (!Number.isSafeInteger(part.size) || part.size <= 0 || part.size >= MAX_STATIC_ASSET_SIZE) {
      throw new Error(`Invalid size for download part ${part.path}`);
    }
    if (index < manifest.parts.length - 1 && part.size !== PART_SIZE) {
      throw new Error(`Non-final download part ${part.path} is not exactly ${PART_SIZE} bytes`);
    }
    if (!/^[a-f0-9]{64}$/.test(part.sha256)) {
      throw new Error(`Invalid SHA-256 digest for ${part.path}`);
    }

    const filePath = join(ROOT, "public", part.path.slice(1));
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size !== part.size) {
      throw new Error(`Prepared download part does not match manifest: ${part.path}`);
    }

    const partHash = createHash("sha256");
    const handle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        const bytes = buffer.subarray(0, bytesRead);
        partHash.update(bytes);
        combinedHash.update(bytes);
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }

    if (partHash.digest("hex") !== part.sha256) {
      throw new Error(`Prepared download part failed SHA-256 validation: ${part.path}`);
    }
    totalSize += part.size;
  }

  if (totalSize !== manifest.totalSize) {
    throw new Error(`Prepared download has ${totalSize} bytes; expected ${manifest.totalSize}`);
  }
  if (combinedHash.digest("hex") !== manifest.sha256) {
    throw new Error("Prepared download parts do not reconstruct the canonical ZIP");
  }

  const publicManifest = JSON.parse(await readFile(PUBLIC_MANIFEST_PATH, "utf8"));
  if (JSON.stringify(publicManifest) !== JSON.stringify(manifest)) {
    throw new Error("Public release manifest is out of sync");
  }

  if (await pathExists(SOURCE_ARCHIVE)) {
    const sourceStats = await stat(SOURCE_ARCHIVE);
    const sourceHash = await sha256File(SOURCE_ARCHIVE);
    if (sourceStats.size !== manifest.totalSize || sourceHash !== manifest.sha256) {
      throw new Error("Release manifest does not match the canonical extension archive");
    }
  }
}

async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
}

async function writeManifest(manifest) {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(MANIFEST_PATH, json);
  await mkdir(PUBLIC_DOWNLOADS_DIR, { recursive: true });
  await writeFile(PUBLIC_MANIFEST_PATH, json);
}

async function copyOcrModels() {
  const modelNames = (await readdir(OCR_MODELS_SOURCE_DIR))
    .filter((name) => name.endsWith(".tar"))
    .sort();

  if (modelNames.length === 0) {
    throw new Error("No OCR model archives were found");
  }

  await rm(OCR_MODELS_PUBLIC_DIR, { recursive: true, force: true });
  await mkdir(OCR_MODELS_PUBLIC_DIR, { recursive: true });

  for (const name of modelNames) {
    const sourcePath = join(OCR_MODELS_SOURCE_DIR, name);
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size >= MAX_STATIC_ASSET_SIZE) {
      throw new Error(`${name} is not a valid Cloudflare static asset`);
    }
    await copyFile(sourcePath, join(OCR_MODELS_PUBLIC_DIR, name));
  }
}

async function validateOcrModels() {
  const sourceNames = (await readdir(OCR_MODELS_SOURCE_DIR))
    .filter((name) => name.endsWith(".tar"))
    .sort();
  const publicNames = (await readdir(OCR_MODELS_PUBLIC_DIR))
    .filter((name) => name.endsWith(".tar"))
    .sort();

  if (JSON.stringify(sourceNames) !== JSON.stringify(publicNames)) {
    throw new Error("Prepared OCR model list does not match extension/public/models");
  }

  for (const name of sourceNames) {
    const sourcePath = join(OCR_MODELS_SOURCE_DIR, name);
    const publicPath = join(OCR_MODELS_PUBLIC_DIR, name);
    const [sourceStats, publicStats, sourceHash, publicHash] = await Promise.all([
      stat(sourcePath),
      stat(publicPath),
      sha256File(sourcePath),
      sha256File(publicPath),
    ]);
    if (
      sourceStats.size !== publicStats.size ||
      publicStats.size >= MAX_STATIC_ASSET_SIZE ||
      sourceHash !== publicHash
    ) {
      throw new Error(`Prepared OCR model does not match its source: ${name}`);
    }
  }
}

let manifest;
if (VERIFY_ONLY) {
  manifest = await readManifest();
} else if (await pathExists(SOURCE_ARCHIVE)) {
  manifest = await generateReleaseManifest();
  await writeManifest(manifest);
  await copyOcrModels();
} else {
  manifest = await readManifest();
  await mkdir(PUBLIC_DOWNLOADS_DIR, { recursive: true });
  await copyFile(MANIFEST_PATH, PUBLIC_MANIFEST_PATH);
  await copyOcrModels();
}

await validatePreparedRelease(manifest);
await validateOcrModels();

console.log(
  `${VERIFY_ONLY ? "Verified" : "Prepared"} ${manifest.fileName}: ${manifest.totalSize} bytes across ${manifest.parts.length} static parts; ${manifest.sha256}`,
);
