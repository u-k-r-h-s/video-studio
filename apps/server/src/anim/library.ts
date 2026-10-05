import fs from "node:fs/promises";
import type { Asset } from "@studio/shared";
import { AssetLibrary } from "./engine";
import { animPaths, readRgba } from "./assets";
import { makeFlashlight, makeHeldPhone, makeLitPhone } from "./loader";
import { addPuppetFace, buildPuppet, puppetHeadCrop } from "./puppet";
import type { AssetManifest } from "./manifest";
import { addHeadVariant, analyzeFigure, buildRig, headCropRect, type Rig, type RigSet } from "./rig";
import { VIEW_NAMES } from "./types";

export interface LibraryReport {
  locations: string[];
  characters: Record<string, { views: string[]; variants: string[] }>;
  props: string[];
  missing: string[];
  /** Where the lit screen is on each phone asset (so a shot can draw its own message there). */
  phoneQuads: Record<string, [number, number][]>;
  /** How each puppet was segmented (arms/legs separated from the body?). */
  puppets: Record<string, { armsSeparated: boolean; legsSeparated: boolean }>;
}

/** Everything the renderer needs, loaded once from the project's generated assets (cut-outs become rigs). */
export async function loadAnimLibrary(opts: { resolve: (rel: string) => string; exists: (rel: string) => boolean; manifest: AssetManifest; assets: Asset[] }): Promise<{ lib: AssetLibrary; report: LibraryReport }> {
  const lib = new AssetLibrary();
  const report: LibraryReport = { locations: [], characters: {}, props: [], missing: [], phoneQuads: {}, puppets: {} };
  const byId = new Map(opts.assets.map((a) => [a.id, a]));
  const have = (id: string): boolean => { const a = byId.get(id); return !!a && a.status === "ready" && opts.exists(animPaths.final(id)); };

  for (const l of opts.manifest.locations) {
    if (!have(l.assetId)) { report.missing.push(l.assetId); continue; }
    const file = opts.resolve(animPaths.final(l.assetId));
    await lib.addImage(l.assetId, file);
    await lib.addImage(`${l.assetId}-soft`, file, { blur: 5 });
    report.locations.push(l.id);
  }

  // procedural hand props: a torch and a phone that a puppet can hold (drawn, so they always fit the hand and the beam)
  lib.images.set("torch", makeFlashlight());
  lib.images.set("held-phone", makeHeldPhone());

  for (const c of opts.manifest.characters) {
    const puppetId = `char-${c.id}-puppet`;
    if (c.assetIds.includes(puppetId)) {
      if (!have(puppetId)) { report.missing.push(puppetId); continue; }
      const cut = await readRgba(opts.resolve(animPaths.final(puppetId)));
      const box = byId.get(puppetId)?.meta?.box as { x: number; y: number; w: number; h: number } | undefined;
      const pup = await buildPuppet(c.id, cut, { box });
      const variants: string[] = [];
      for (const id of c.assetIds.filter((x) => x.startsWith("head-"))) {
        if (!have(id)) { report.missing.push(id); continue; }
        const name = id.slice(`head-${c.id}-`.length);
        await addPuppetFace(pup, name, await readRgba(opts.resolve(animPaths.final(id))), puppetHeadCrop(pup));
        variants.push(name);
      }
      lib.addPuppet(pup);
      report.characters[c.id] = { views: ["puppet"], variants };
      report.puppets[c.id] = pup.report;
      continue;
    }
    const views: RigSet["views"] = {};
    let frontCut: Awaited<ReturnType<typeof readRgba>> | null = null;
    for (const v of VIEW_NAMES) {
      const id = `char-${c.id}-${v}`;
      if (!c.assetIds.includes(id)) continue;
      if (!have(id)) { report.missing.push(id); continue; }
      const cut = await readRgba(opts.resolve(animPaths.final(id)));
      if (v === "front") frontCut = cut;
      views[v] = await buildRig(c.id, cut, { view: v, nativeFacing: -1 });
    }
    const front = views.front as Rig | undefined;
    const variants: string[] = [];
    if (front && frontCut) {
      const rect = headCropRect(analyzeFigure(frontCut));
      for (const id of c.assetIds.filter((x) => x.startsWith("head-"))) {
        if (!have(id)) { report.missing.push(id); continue; }
        const name = id.slice(`head-${c.id}-`.length);
        await addHeadVariant(front, name, await readRgba(opts.resolve(animPaths.final(id))), rect);
        variants.push(name);
      }
      // the redrawn neutral head is crisper than the one cut from the body: use it as the base so all heads share a hairline
      if (front.variants.front) front.head = front.variants.front;
    }
    if (Object.keys(views).length) lib.addRig({ id: c.id, views });
    report.characters[c.id] = { views: Object.keys(views), variants };
  }

  for (const p of opts.manifest.props) {
    if (!have(p.assetId)) { report.missing.push(p.assetId); continue; }
    await lib.addImage(p.assetId, opts.resolve(animPaths.final(p.assetId)));
    report.props.push(p.id);
    // a phone gets a lit screen (and a message when a shot has one); the screen is inside the box the first matte pass found
    const meta = byId.get(p.assetId)?.meta as { primaryBox?: { x: number; y: number; w: number; h: number } } | undefined;
    if (p.kind === "phone" && meta?.primaryBox) {
      const img = lib.images.get(p.assetId)!;
      const quad = screenQuad(meta.primaryBox);
      report.phoneQuads[p.assetId] = quad;
      lib.images.set(`${p.assetId}-lit`, await makeLitPhone(img, quad));
    }
  }
  return { lib, report };
}

/** The lit screen of a held phone: the phone's box inset by its bezel. */
export function screenQuad(b: { x: number; y: number; w: number; h: number }): [number, number][] {
  const x0 = b.x + b.w * 0.08, x1 = b.x + b.w * 0.92, y0 = b.y + b.h * 0.07, y1 = b.y + b.h * 0.93;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export async function fileSize(file: string): Promise<number> { return (await fs.stat(file)).size; }
