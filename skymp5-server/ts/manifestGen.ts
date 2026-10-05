import { Settings } from "./settings";
import * as crc32 from "crc-32";
import * as path from "path";
import * as fs from "fs";

interface ManifestModEntry {
  filename: string;
  crc32: number;
  size: number;
}

interface Manifest {
  versionMajor: number;
  mods: Array<ManifestModEntry>;
  loadOrder: Array<string>;
}

interface CachedCrc {
  size: number;
  mtimeMs: number;
  crc32: number;
}

// Plugin CRCs by file name, valid while size and mtime match
const crcCachePath = path.resolve("data", "manifest-cache.json");

const readCrcCache = (): Record<string, CachedCrc> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(crcCachePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const generateManifest = (settings: Settings): void => {
  const manifest: Manifest = {
    mods: [],
    versionMajor: 1,
    loadOrder: settings.loadOrder.map(x => path.basename(x)),
  };

  const cache = readCrcCache();
  const nextCache: Record<string, CachedCrc> = {};
  let hashed = 0;

  settings.loadOrder.forEach((loadOrderElement) => {
    const espmName = path.isAbsolute(loadOrderElement)
      ? path.basename(loadOrderElement)
      : loadOrderElement;

    const espmPath = path.isAbsolute(loadOrderElement)
      ? loadOrderElement
      : path.join(settings.dataDir, espmName);

    const { size, mtimeMs } = fs.statSync(espmPath);
    let entry = cache[espmName];
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs || typeof entry.crc32 !== "number") {
      const buf: Uint8Array = fs.readFileSync(espmPath);
      entry = { size: buf.length, mtimeMs, crc32: crc32.buf(buf) };
      hashed++;
    }
    nextCache[espmName] = entry;
    manifest.mods.push({
      crc32: entry.crc32,
      filename: espmName,
      size: entry.size,
    });
  });

  console.log(`Manifest: ${manifest.mods.length} plugin(s), ${hashed} hashed, ${manifest.mods.length - hashed} from manifest-cache.json`);

  const manifestPath = path.join(settings.dataDir, "manifest.json");
  // Create the data dir if missing so a fresh deployment doesn't crash on startup.
  fs.mkdirSync(settings.dataDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));

  // ui.ts serves the cwd-relative "data" folder, not dataDir.
  // Mirror the manifest there so clients never see a stale copy.
  const servedPath = path.resolve("data", "manifest.json");
  if (path.resolve(manifestPath) !== servedPath) {
    fs.mkdirSync(path.dirname(servedPath), { recursive: true });
    fs.writeFileSync(servedPath, JSON.stringify(manifest, null, 4));
  }

  const cacheText = JSON.stringify(nextCache, null, 2);
  if (cacheText !== JSON.stringify(cache, null, 2)) {
    try {
      fs.mkdirSync(path.dirname(crcCachePath), { recursive: true });
      fs.writeFileSync(crcCachePath, cacheText);
    } catch (e) {
      console.error(`Could not write ${crcCachePath}:`, e);
    }
  }
};
