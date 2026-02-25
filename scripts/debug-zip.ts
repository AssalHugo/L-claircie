/**
 * debug-zip.ts
 * Inspecte la structure réelle du ZIP AMO10 sans rien insérer en base.
 * Lance ce script, copie la sortie et partage-la.
 *
 * Usage : npx tsx scripts/debug-zip.ts
 */

import * as zlib   from "zlib";
import { promisify } from "util";

const ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/amo" +
  "/deputes_actifs_mandats_actifs_organes" +
  "/AMO10_deputes_actifs_mandats_actifs_organes.json.zip";

const inflateRaw = promisify(zlib.inflateRaw);

async function parseZip(buf: Buffer) {
  const entries: { name: string; data: Buffer }[] = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method    = buf.readUInt16LE(i + 8);
    const compSize  = buf.readUInt32LE(i + 18);
    const nameLen   = buf.readUInt16LE(i + 26);
    const extraLen  = buf.readUInt16LE(i + 28);
    const name      = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    if (compSize > 0 && !name.endsWith("/")) {
      try {
        const data = method === 0 ? compressed
          : method === 8 ? (await inflateRaw(compressed) as Buffer) : null;
        if (data) entries.push({ name, data });
      } catch { /* ignoré */ }
    }
    i = dataStart + compSize;
  }
  return entries;
}

async function main() {
  console.log("📥 Téléchargement...");
  const res = await fetch(ZIP_URL, { headers: { "User-Agent": "debug/1.0" } });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`✅ ${(buf.length / 1024 / 1024).toFixed(1)} MB\n`);

  const entries = await parseZip(buf);
  console.log(`📦 ${entries.length} entrées dans le ZIP\n`);

  // ── 1. Affiche les 20 premiers noms de fichiers ──
  console.log("=== 20 PREMIERS NOMS DE FICHIERS ===");
  entries.slice(0, 20).forEach((e, idx) => console.log(`[${idx}] ${e.name}`));

  // ── 2. Inspecte le premier fichier .json ──
  const first = entries.find(e => e.name.endsWith(".json"));
  if (first) {
    console.log(`\n=== CONTENU BRUT DU PREMIER JSON : ${first.name} ===`);
    const text = first.data.toString("utf8");
    console.log(text.substring(0, 2000));
    console.log("\n=== CLÉS DE PREMIER NIVEAU ===");
    try {
      const parsed = JSON.parse(text);
      console.log("Type :", typeof parsed);
      if (typeof parsed === "object" && parsed !== null) {
        const keys = Object.keys(parsed);
        console.log("Clés :", keys);
        // Si c'est un tableau, montre le premier élément
        if (Array.isArray(parsed)) {
          console.log("C'est un tableau de", parsed.length, "éléments");
          console.log("Premier élément (clés) :", Object.keys(parsed[0] ?? {}));
          console.log("Premier élément (aperçu) :", JSON.stringify(parsed[0]).substring(0, 500));
        } else {
          // Pour chaque clé de premier niveau, montre le type et un aperçu
          keys.forEach(k => {
            const val = (parsed as Record<string, unknown>)[k];
            const type = Array.isArray(val) ? `array(${(val as unknown[]).length})` : typeof val;
            const preview = JSON.stringify(val).substring(0, 200);
            console.log(`\n  "${k}" [${type}] :`, preview);
          });
        }
      }
    } catch (err) {
      console.log("Erreur de parsing JSON :", err);
      console.log("Début du fichier (raw) :", first.data.slice(0, 200).toString("hex"));
    }
  }

  // ── 3. Inspecte quelques autres fichiers pour voir si la structure est homogène ──
  const jsonFiles = entries.filter(e => e.name.endsWith(".json"));
  console.log(`\n=== TOTAL FICHIERS JSON : ${jsonFiles.length} ===`);
  console.log("Quelques noms représentatifs :");
  [0, 1, 2, Math.floor(jsonFiles.length / 2), jsonFiles.length - 1].forEach(idx => {
    if (jsonFiles[idx]) console.log(`  [${idx}] ${jsonFiles[idx].name}`);
  });
}

main().catch(console.error);
