import fs from "node:fs/promises";
import { extractAssetRefsFromMarkdown } from "../../core/assets.js";
import { createSnapshotProjection } from "../../core/snapshot-projection.js";
import { buildSnapshotHtml } from "../../core/snapshot-html.js";
import { CANVAS_STYLES } from "../../core/html/styles.js";
import { toPersistedHole } from "../../core/schema.js";
import { resolveAsset } from "../fs-store.js";
import { getDompurifyScript, getFrozenClientBundle, getKatexCss } from "../html/built-assets.js";

/** @param {import("./session.js").RabbitHoleSession} session */
export async function buildSessionSnapshotProjection(session) {
  const hole = toPersistedHole(session.toHole());
  const referencedNames = new Set();
  for (const node of hole.nodes) {
    for (const name of extractAssetRefsFromMarkdown(node.markdown)) referencedNames.add(name);
  }
  const assets = {};
  for (const name of [...referencedNames].sort()) {
    assets[name] = "";
    if (!session.assetNames.has(name)) continue;
    try {
      const filePath = await resolveAsset(session.holeId, name);
      if (filePath) assets[name] = (await fs.readFile(filePath)).toString("base64");
    } catch {}
  }
  return createSnapshotProjection(hole, session.viewState, assets);
}

/** @param {import("./session.js").RabbitHoleSession} session */
export async function buildSessionExportHtml(session) {
  const snapshotProjection = await buildSessionSnapshotProjection(session);
  return buildSnapshotHtml({
    title: snapshotProjection.hole.title || "Rabbithole",
    stylesheetText: `${CANVAS_STYLES}\n${getKatexCss()}`,
    dompurifySource: getDompurifyScript(),
    frozenClientSource: getFrozenClientBundle(),
    snapshotProjection,
  });
}
