import assert from "node:assert/strict";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { IdbStore } from "../../src/web/store/idb-store.js";
import { DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";
import { runStoreContract } from "../support/store-contract.mjs";

import "fake-indexeddb/auto";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
  storage: {
    persist: async () => true,
  },
  },
});

await verifyVersionThreeCleanBreak();

const store = assertRabbitholeStore(new IdbStore({ dbName: `rabbithole-indexeddb-store-${Date.now()}` }));

await runStoreContract(store, {
  readRawHole: (holeId) => rawHole("readonly", holeId),
  writeRawHole: (_holeId, fixture) => rawHole("readwrite", fixture),
  makeDeleteHost: async ({ root, childA, childB }) => {
    const host = new DirectRabbitholeHost({
      store,
      hole: {
        hole_id: "gc-hole",
        title: "GC Hole",
        root_id: "root",
        created_at: "2026-01-01T00:00:00.000Z",
        view_state: null,
        nodes: [root, childA, childB],
      },
    });
    return {
      deleteNode: (nodeId) => host.handleDeleteNode({ node_id: nodeId }),
      close: () => host.flushSave(),
    };
  },
});

async function verifyVersionThreeCleanBreak() {
  const dbName = `rabbithole-indexeddb-upgrade-${Date.now()}`;
  const request = indexedDB.open(dbName, 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("holes", { keyPath: "hole_id" }).put({ hole_id: "legacy-uuid", title: "Legacy" });
    db.createObjectStore("hole-summaries", { keyPath: "hole_id" }).put({ hole_id: "legacy-uuid", title: "Legacy" });
    db.createObjectStore("assets", { keyPath: ["hole_id", "name"] }).put({ hole_id: "legacy-uuid", name: "page.png", blob: new Blob() });
    db.createObjectStore("staging", { keyPath: ["ingest_id", "name"] }).put({ ingest_id: "ingest-old", name: "page.png", blob: new Blob() });
    db.createObjectStore("meta", { keyPath: "key" }).put({ key: "staging:ingest-old" });
  };
  const legacyDb = await requestResult(request);
  legacyDb.close();

  const upgraded = new IdbStore({ dbName });
  assert.deepEqual(await upgraded.listHoles(), [], "version 3 upgrade should clear UUID-backed browser documents");
  const db = await upgraded.open();
  const tx = db.transaction(["holes", "hole-summaries", "assets", "staging", "meta"], "readonly");
  const counts = await Promise.all(["holes", "hole-summaries", "assets", "staging", "meta"].map((name) => requestResult(tx.objectStore(name).count())));
  assert.deepEqual(counts, [0, 0, 0, 0, 0], "clean break should clear documents, assets, and staging metadata atomically");
  db.close();
  console.log("ok IndexedDB v3 clean break clears legacy browser records");
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawHole(mode, value) {
  const db = await store.open();
  const tx = db.transaction("holes", mode);
  const request = mode === "readonly" ? tx.objectStore("holes").get(value) : tx.objectStore("holes").put(structuredClone(value));
  const result = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  return mode === "readonly" && result ? structuredClone(result) : result;
}

console.log("IndexedDB store contract verification passed");
