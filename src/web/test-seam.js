/*
 * Rule 10 test contract: this is the sole shipped test seam. Every entry below
 * exists only for state or artifact inspection that cannot be observed through
 * the product UI; product actions themselves must be driven through real UI.
 */
export function installTestSeam({ store, currentHoleId, createDocument, exportSnapshot }) {
  window.__rabbitholeTest = Object.freeze({
    version: 1,
    // Routing/reload fixtures need the active storage identity, which is not rendered.
    currentHoleId,
    // Persistence fixtures need the exact pre-migration IndexedDB record.
    readStoredHole: async (id = currentHoleId()) => id ? readRawRecord(store, id) : null,
    // Ingest fixtures must verify binary asset names and byte sizes, neither rendered in UI.
    inspectAssets: async (id = currentHoleId()) => {
      const names = id ? await store.listAssets(id) : [];
      const sizes = {};
      for (const name of names) sizes[name] = (await store.getAsset(id, name))?.size || 0;
      return { names, sizes };
    },
    // MIME migration fixtures need the stored Blob type, which live rendering hides.
    inspectAssetType: async (name, id = currentHoleId()) => (await store.getAsset(id, name))?.type || "",
    // Empty-store persistence assertions cannot distinguish zero records from empty rail copy.
    listStoredHoles: () => store.listHoles(),
    // Structured-authoring fixtures have no paste/import UI that requests author-model rewriting.
    createDocument,
    // Byte/content gauges require the generated snapshot string before a browser download.
    exportSnapshot,
  });
}

async function readRawRecord(store, id) {
  const db = await store.open();
  const tx = db.transaction("holes", "readonly");
  const request = tx.objectStore("holes").get(id);
  const value = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
  return value == null ? null : structuredClone(value);
}
