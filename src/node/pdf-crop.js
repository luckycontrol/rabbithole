import fs from "node:fs/promises";
import path from "node:path";
import { planPdfCrop } from "../core/pdf-shared.js";
import { ensureAssetDir, resolveAsset } from "./fs-store.js";

export async function cropPdfRegionToFile({ holeId, asset, rect, requestId }) {
  const source = await resolveAsset(holeId, asset);
  if (!source) throw new Error("PDF page asset is missing.");
  const canvas = await import("@napi-rs/canvas").catch((error) => { throw new Error(`PDF crop support is unavailable: ${error.message}`); });
  const image = await canvas.loadImage(source);
  const plan = planPdfCrop(rect, image.width, image.height);
  if (!plan) throw new Error("PDF selection region is empty.");
  const surface = canvas.createCanvas(plan.width, plan.height);
  const context = surface.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, plan.width, plan.height);
  context.drawImage(image, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);
  const safeRequest = String(requestId || "selection").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "selection";
  const filePath = path.join(await ensureAssetDir(holeId), `region-${safeRequest}.jpg`);
  await fs.writeFile(filePath, surface.toBuffer("image/jpeg", 85));
  surface.width = 0; surface.height = 0;
  return filePath;
}
