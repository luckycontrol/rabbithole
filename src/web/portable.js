import { getAssetContentType, MAX_ASSET_BYTES, validateAssetName } from "../core/assets.js";
import {
  base64ToBytes,
  binaryToBase64,
  createPortableProjection,
  RABBITHOLE_FILE_FORMAT,
  RABBITHOLE_FILE_FORMAT_VERSION,
  validatePortableProjection,
} from "../core/portable-projection.js";
import { migratePersistedHole } from "../core/schema.js";

export { RABBITHOLE_FILE_FORMAT, RABBITHOLE_FILE_FORMAT_VERSION };

export async function buildRabbitholeExport(store, holeId) {
  if (!store) throw new Error("Export needs a store.");
  const hole = await store.loadHole(holeId);
  if (!hole) throw new Error("That Rabbithole no longer exists.");
  const persisted = hole;
  const assets = {};
  for (const name of await store.listAssets(persisted.hole_id)) {
    validateAssetName(name);
    const blob = await store.getAsset(persisted.hole_id, name);
    if (blob) assets[name] = await binaryToBase64(blob);
  }
  return createPortableProjection(persisted, assets);
}

export async function downloadRabbitholeExport(store, holeId) {
  const payload = await buildRabbitholeExport(store, holeId);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = rabbitholeFilename(payload.hole?.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return payload;
}

export async function importRabbitholeFile(store, fileOrText) {
  if (!store) throw new Error("Import needs a store.");
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parseRabbitholeFile(text);
  const migrated = migratePersistedHole(parsed.hole).hole;
  const assets = await decodeAssets(parsed.assets);
  let hole = migrated;
  let collision = false;
  if (await store.loadHole(hole.hole_id)) {
    collision = true;
    hole = { ...hole, hole_id: await freshHoleId(store) };
  }

  await store.saveHole(hole, { updatedAt: hole.updated_at || new Date().toISOString() });
  for (const asset of assets) {
    await store.putAsset(hole.hole_id, asset.name, asset.blob);
  }
  return {
    hole_id: hole.hole_id,
    title: hole.title,
    asset_count: assets.length,
    collision,
  };
}

export function parseRabbitholeFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("Import failed: .rabbithole must be valid JSON.");
  }
  return validatePortableProjection(parsed);
}

export function rabbitholeFilename(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "untitled"}.rabbithole`;
}

async function decodeAssets(rawAssets) {
  const out = [];
  for (const [name, encoded] of Object.entries(rawAssets || {})) {
    const safeName = validateAssetName(name);
    const bytes = base64ToBytes(encoded);
    const blob = new Blob([bytes], { type: getAssetContentType(safeName) });
    if (blob.size > MAX_ASSET_BYTES) throw new Error(`Import failed: asset ${safeName} exceeds 20 MB.`);
    out.push({ name: safeName, blob });
  }
  return out;
}

async function freshHoleId(store) {
  for (let i = 0; i < 20; i += 1) {
    const id = newHoleId();
    if (!(await store.loadHole(id))) return id;
  }
  throw new Error("Import failed: could not generate a fresh hole id.");
}

function newHoleId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `hole-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
