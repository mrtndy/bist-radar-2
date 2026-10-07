/**
 * File access for the generated bar data under `data/bars/` (Node only: uses node:fs).
 *
 * Why this exists: every pipeline copy (lib/scan-data.ts, lib/detail.ts, scripts/scan.ts,
 * scripts/study.ts) needs the same three things besides the bars: the list of symbol files,
 * the reference "now" for the closed-bar rule, and the data-quality reports. Reading them in
 * one place keeps the pipelines consistent. The engine math stays pure in the other files;
 * only this module touches the disk. Do not import it from "use client" components.
 *
 * Files read (all written by ingest/ingest.py, all gitignored):
 *   data/bars/<TF>/<SYMBOL>.json   bars, oldest first
 *   data/bars/<TF>.meta.json       run metadata: startedAt, fetchedAt (epoch ms)
 *   data/bars/<TF>.quality.json    quality report (missing, stale, jumps, gaps)
 *
 * What it does when run: nothing on its own; library module.
 *
 * How to see it work:
 *   node -e "import('./src/engine/data-files.ts').then(async m => console.log(await m.readRunTimes('data','G')))"
 *   # -> { startedAt: null, fetchedAt: 1791361139250 }   (startedAt is null for runs before 2026-10-07)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { QualityContext, QualityReport } from "./quality.ts";
import type { Timeframe } from "./types.ts";

/** Start and end of the ingest run that produced a timeframe's bars (epoch ms, null if unknown). */
export interface RunTimes {
  startedAt: number | null;
  fetchedAt: number | null;
}

/** Symbol bar files of one timeframe: "<SYMBOL>.json" names, unsorted. */
export async function listBarFiles(dataDir: string, tf: Timeframe): Promise<string[]> {
  const files = await readdir(path.join(dataDir, "bars", tf));
  return files.filter((f) => f.endsWith(".json"));
}

/** Reads `data/bars/<TF>.meta.json`; missing or broken file gives nulls (never throws). */
export async function readRunTimes(dataDir: string, tf: Timeframe): Promise<RunTimes> {
  try {
    const raw = await readFile(path.join(dataDir, "bars", `${tf}.meta.json`), "utf8");
    const meta = JSON.parse(raw) as { startedAt?: unknown; fetchedAt?: unknown };
    return {
      startedAt: typeof meta.startedAt === "number" ? meta.startedAt : null,
      fetchedAt: typeof meta.fetchedAt === "number" ? meta.fetchedAt : null,
    };
  } catch {
    return { startedAt: null, fetchedAt: null };
  }
}

/**
 * The instant the closed-bar rule should use. The ingest START is the right reference: the
 * first batch was downloaded then, and a bar that closed during the 2-4 minute run was still
 * open in that batch. Older meta files only have the end time; the last resort is the clock.
 */
export function referenceNow(times: RunTimes, fallback: number = Date.now()): number {
  return times.startedAt ?? times.fetchedAt ?? fallback;
}

/** Reads `data/bars/<TF>.quality.json`; missing or broken file gives null (gate disabled). */
export async function readQualityReport(dataDir: string, tf: Timeframe): Promise<QualityReport | null> {
  try {
    const raw = await readFile(path.join(dataDir, "bars", `${tf}.quality.json`), "utf8");
    const r = JSON.parse(raw) as Partial<QualityReport>;
    // Defensive defaults: an older or hand-edited report may lack a section.
    return {
      timeframe: (r.timeframe ?? tf) as Timeframe,
      generatedAt: r.generatedAt ?? 0,
      newestBarAt: r.newestBarAt ?? null,
      newestSession: r.newestSession ?? null,
      missing: Array.isArray(r.missing) ? r.missing : [],
      stale: r.stale ?? {},
      jumps: r.jumps ?? {},
    };
  } catch {
    return null;
  }
}

/** The reports one timeframe's scan needs: its own, plus the daily one for H and S. */
export async function loadQualityContext(dataDir: string, tf: Timeframe): Promise<QualityContext> {
  const own = await readQualityReport(dataDir, tf);
  const daily = tf === "G" ? own : await readQualityReport(dataDir, "G");
  return { own, daily };
}
