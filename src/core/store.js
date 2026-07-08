/**
 * RabbitholeStore port.
 *
 * Implementations must provide:
 * - listHoles(): Promise<Array<{ hole_id, title, updated_at, node_count }>>
 * - loadHole(holeId): Promise<PersistedHole | null>
 * - saveHole(hole): Promise<void>
 * - deleteHole(holeId): Promise<void>
 * - listAssets(holeId): Promise<string[]>
 * - getAsset(holeId, name): Promise<Blob | Uint8Array | null>
 * - putAsset(holeId, name, bytes): Promise<void>
 * - deleteAsset(holeId, name): Promise<void>
 * - createStaging(): Promise<{ ingest_id: string }>
 * - putStagedAsset(ingestId, name, bytes): Promise<void>
 * - adoptStagedAssets(holeId, ingestId): Promise<string[]>
 */

export const RABBITHOLE_STORE_METHODS = Object.freeze([
  "listHoles",
  "loadHole",
  "saveHole",
  "deleteHole",
  "listAssets",
  "getAsset",
  "putAsset",
  "deleteAsset",
  "createStaging",
  "putStagedAsset",
  "adoptStagedAssets",
]);

export function assertRabbitholeStore(store) {
  for (const method of RABBITHOLE_STORE_METHODS) {
    if (typeof store?.[method] !== "function") throw new Error(`RabbitholeStore missing ${method}()`);
  }
  return store;
}
