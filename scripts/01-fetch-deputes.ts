/**
 * 01-fetch-deputes.ts  (v4 — structure réelle vérifiée du ZIP AMO10)
 * ------------------------------------------------------------------
 * Source :
 *   https://data.assemblee-nationale.fr/static/openData/repository/17/amo/
 *   deputes_actifs_mandats_actifs_organes/
 *   AMO10_deputes_actifs_mandats_actifs_organes.json.zip
 *
 * Structure réelle du ZIP (vérifiée par debug) :
 *   json/acteur/PA{uid}.json  →  { acteur: {..., mandats: {...} } }
 *   json/organe/PO{uid}.json  →  { organe: {..., codeType, libelle, ... } }
 *
 * Les deux sont SÉPARÉS — le fichier acteur contient des organeRef dans ses
 * mandats, qu'on résout en cherchant le fichier organe correspondant.
 *
 * Particularités JSON de l'AN à gérer :
 *   - uid est un objet :  { "@xsi:type": "...", "#text": "PA841605" }
 *   - mandat peut être un objet OU un tableau
 *   - organeRef peut être une string OU un tableau
 *
 * Étapes :
 *   1. Télécharge + parse le ZIP
 *   2. Sépare les fichiers acteur/ et organe/
 *   3. Construit une Map uid → organe pour les groupes GP
 *   4. Pour chaque acteur : trouve son mandat GP → résout le groupe
 *   5. Upsert dim_groupe, dim_depute, dim_depute_groupe_historique
 *
 * Usage : npx tsx scripts/01-fetch-deputes.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as zlib from "zlib";
import { promisify } from "util";

dotenv.config({ path: ".env.local" });

// ─── Validation env ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error("❌ Variables manquantes dans .env.local");
  if (!SUPABASE_URL) console.error("   → NEXT_PUBLIC_SUPABASE_URL");
  if (!SUPABASE_SERVICE) console.error("   → SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// ─── Configuration ─────────────────────────────────────────────────────────
const ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/amo" +
  "/deputes_actifs_mandats_actifs_organes" +
  "/AMO10_deputes_actifs_mandats_actifs_organes.json.zip";

const LEGISLATURE_START = "2024-07-18";

// Couleurs pour l'UI météo — l'AN ne les fournit pas, enrichissement manuel.
// Clés = sigle exact tel qu'il apparaît dans libelleAbrev des fichiers AN.
// ⚠️  Vérifier la sortie du script : si un groupe a la couleur #888888,
//     son sigle n'est pas dans cette map — ajoute-le.
const COULEURS_PAR_SIGLE: Record<string, string> = {
  "RN": "#003189",
  "EPR": "#E1000F",
  "LFI-NFP": "#CC2443",
  "SOC": "#B73060",
  "DR": "#1F3260",
  "ECOS": "#3DB551",
  "DEM": "#FF6600",
  "HOR": "#1B4F9C",
  "LIOT": "#8B6914",
  "GDR": "#BE0000",
  "UDDPLR": "#2E4057",  // Sigle réel dans les fichiers AN
  "NI": "#AAAAAA",  // Non-inscrits — gris neutre
};


// ─── Parser ZIP natif ──────────────────────────────────────────────────────
interface ZipEntry { name: string; data: Buffer; }
const inflateRaw = promisify(zlib.inflateRaw);

async function parseZip(buf: Buffer): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    if (compSize > 0 && !name.endsWith("/")) {
      try {
        const data = method === 0 ? compressed
          : method === 8 ? (await inflateRaw(compressed) as Buffer) : null;
        if (data) entries.push({ name, data });
      } catch { /* corrompu, ignoré */ }
    }
    i = dataStart + compSize;
  }
  return entries;
}

// ─── Types JSON réels de l'AN ──────────────────────────────────────────────
// Basés sur l'inspection directe du fichier PA841605.json

// L'uid est un objet avec @xsi:type et #text — PAS une simple string
interface UidAN {
  "#text": string;
  "@xsi:type"?: string;
}

interface OrganeAN {
  uid: string;
  codeType: string;    // "GP", "ASSEMBLEE", "PARPOL", etc.
  libelle: string;
  libelleAbrev?: string;    // Sigle court : "RN", "EPR", etc.
  libelleAbrevOrgane?: string;
  libelleEdition?: string;
  // Nombre de membres — présent dans certaines versions des fichiers AN
  effectif?: number | string | { "#text": string } | null;
  nombreMembres?: number | string | null;
}

interface MandatAN {
  uid?: string | UidAN;
  typeOrgane: string;
  dateDebut?: string;
  dateFin?: string | null | { "@xsi:nil": string };
  organes?: {
    organeRef: string | string[];
  };
  election?: {
    lieu?: {
      numDepartement?: string;
      numCirco?: string | number;
      intituleCirco?: string;
    };
  };
}

interface ActeurAN {
  uid: UidAN | string;
  etatCivil: {
    ident: { nom: string; prenom: string; civ?: string };
  };
  profession?: { libelleCourant?: string };
  mandats?: {
    mandat: MandatAN | MandatAN[];
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// L'uid peut être { "#text": "PA..." } ou directement "PA..."
function resolveUid(val: UidAN | string | undefined): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  return val["#text"] ?? "";
}

// L'AN renvoie parfois un objet seul là où on attend un tableau
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === null || val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

// organeRef peut être une string ou un tableau — on veut toujours le premier
function firstRef(m: MandatAN): string | null {
  const ref = m.organes?.organeRef;
  if (!ref) return null;
  return Array.isArray(ref) ? ref[0] : ref;
}

// dateFin peut être null, une string, ou { "@xsi:nil": "true" } = null XML
function isDateFinNull(dateFin: MandatAN["dateFin"]): boolean {
  if (dateFin === null || dateFin === undefined) return true;
  if (typeof dateFin === "object" && "@xsi:nil" in dateFin) return true;
  return false;
}

async function batchUpsert<T extends object>(
  table: string, rows: T[], conflict: string, size = 50
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    const { data, error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + size), { onConflict: conflict })
      .select("id");
    if (error) throw new Error(`${table} (lot ${i}): ${error.message}`);
    n += data?.length ?? 0;
    process.stdout.write(`  → ${Math.min(i + size, rows.length)}/${rows.length}\r`);
  }
  process.stdout.write("\n");
  return n;
}

// ─── 1. Téléchargement ──────────────────────────────────────────────────────
async function downloadZip(): Promise<Buffer> {
  console.log("📥 Téléchargement AMO10 depuis l'Assemblée nationale...");
  console.log(`   ${ZIP_URL}\n`);
  const res = await fetch(ZIP_URL, {
    headers: { "User-Agent": "Redevabilite2027/1.0 (civic-tech open-source)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`   ✅ ${(buf.length / 1024 / 1024).toFixed(1)} MB reçus\n`);
  return buf;
}

// ─── 2. Parsing : sépare acteurs et organes ──────────────────────────────────
async function parseData(zip: Buffer): Promise<{
  acteurs: ActeurAN[];
  organes: Map<string, OrganeAN>;  // uid PO{...} → organe
}> {
  console.log("🔍 Extraction et parsing du ZIP...");
  const entries = await parseZip(zip);
  console.log(`   ${entries.length} entrées dans le ZIP`);

  const acteurs: ActeurAN[] = [];
  const organes = new Map<string, OrganeAN>();
  let errors = 0;

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(entry.data.toString("utf8"));
    } catch {
      errors++;
      continue;
    }

    // Détection par chemin — structure vérifiée : json/acteur/ et json/organe/
    if (entry.name.includes("/acteur/")) {
      const a = (parsed as { acteur: ActeurAN }).acteur;
      if (a?.uid) acteurs.push(a);
    } else if (entry.name.includes("/organe/")) {
      const o = (parsed as { organe: OrganeAN }).organe;
      if (o?.uid) organes.set(o.uid, o);
    }
  }

  const gp = [...organes.values()].filter(o => o.codeType === "GP");
  if (errors > 0) console.warn(`   ⚠️  ${errors} fichiers non parsables ignorés`);
  console.log(`   → ${acteurs.length} acteurs`);
  console.log(`   → ${organes.size} organes (dont ${gp.length} groupes GP)\n`);

  return { acteurs, organes };
}

// ─── 3. Upsert des groupes politiques ────────────────────────────────────────
async function upsertGroupes(
  organes: Map<string, OrganeAN>,
  acteurs: ActeurAN[]
): Promise<Map<string, { id: number; sigle: string }>> {
  console.log("📋 Étape 1/3 — Groupes politiques...\n");

  const seatsCount = new Map<string, number>();
  for (const a of acteurs) {
    const mandats = toArray(a.mandats?.mandat);
    // Mandat GP actif = typeOrgane "GP" ET dateFin null/absent
    const mandatGP = mandats.find(
      m => m.typeOrgane === "GP" && isDateFinNull(m.dateFin)
    ) ?? mandats.find(m => m.typeOrgane === "GP");

    const gpRef = mandatGP ? firstRef(mandatGP) : null;
    if (gpRef) {
      seatsCount.set(gpRef, (seatsCount.get(gpRef) ?? 0) + 1);
    }
  }

  const gp = [...organes.values()].filter(o => o.codeType === "GP");

  const rows = gp.map(g => {
    // Priorité sur libelleAbrev, puis libelleAbrevOrgane, puis premier mot du libellé
    const sigle = (g.libelleAbrev ?? g.libelleAbrevOrgane ?? g.libelle.split(" ")[0])
      .toUpperCase()
      .substring(0, 20);
    // Calcul du nombre de sièges depuis les mandats actifs des acteurs
    const nb_sieges = seatsCount.get(g.uid) ?? 0;


    return {
      uid_officiel: g.uid,
      sigle,
      nom_complet: g.libelle,
      couleur_hex: COULEURS_PAR_SIGLE[sigle] ?? "#888888",
      nb_sieges,
      actif: true,
    };
  });

  // Affichage avant insertion pour vérification manuelle
  rows.sort((a, b) => a.sigle.localeCompare(b.sigle)).forEach(r => {
    const ok = r.couleur_hex !== "#888888" ? "✅" : "⚠️ ";
    console.log(`  ${ok} ${r.uid_officiel}  ${r.sigle.padEnd(12)} ${r.nom_complet}`);
  });
  console.log();

  const { data, error } = await supabase
    .from("dim_groupe")
    .upsert(rows, { onConflict: "uid_officiel" })
    .select("id, sigle, uid_officiel");

  if (error) throw new Error(`dim_groupe: ${error.message}`);
  console.log(`   ✅ ${data?.length} groupes insérés / mis à jour\n`);

  const map = new Map<string, { id: number; sigle: string }>();
  data?.forEach(g => map.set(g.uid_officiel, { id: g.id, sigle: g.sigle }));
  return map;
}

// ─── 4. Upsert des députés ────────────────────────────────────────────────────
async function upsertDeputes(
  acteurs: ActeurAN[],
  groupeMap: Map<string, { id: number; sigle: string }>
): Promise<void> {
  console.log("🏛️  Étape 2/3 — Députés...\n");

  const rows: {
    uid_an: string; nom: string; prenom: string; groupe_id: number;
    departement: string; num_circo: number;
    profession: string | null; photo_url: null; actif: boolean;
  }[] = [];

  const sansGroupe: string[] = [];

  for (const a of acteurs) {
    const uidActeur = resolveUid(a.uid as UidAN | string);
    const nom = a.etatCivil?.ident?.nom ?? "";
    const prenom = a.etatCivil?.ident?.prenom ?? "";
    if (!uidActeur || !nom) continue;

    const mandats = toArray(a.mandats?.mandat);

    // Mandat GP actif = typeOrgane "GP" ET dateFin null/absent
    // (Le fichier AMO contient uniquement les mandats actifs, mais on filtre
    // quand même pour être robuste si la structure change)
    const mandatGP = mandats.find(
      m => m.typeOrgane === "GP" && isDateFinNull(m.dateFin)
    ) ?? mandats.find(m => m.typeOrgane === "GP"); // fallback sans filtre dateFin

    const gpRef = mandatGP ? firstRef(mandatGP) : null;
    const groupe = gpRef ? groupeMap.get(gpRef) : null;

    if (!groupe) {
      sansGroupe.push(`${prenom} ${nom} (${uidActeur})`);
      continue;
    }

    // Circonscription depuis le mandat ASSEMBLEE
    const mandatAN = mandats.find(m => m.typeOrgane === "ASSEMBLEE");
    const lieu = mandatAN?.election?.lieu;

    rows.push({
      uid_an: uidActeur,
      nom, prenom,
      groupe_id: groupe.id,
      departement: lieu?.intituleCirco ?? lieu?.numDepartement ?? "Inconnu",
      num_circo: Number(lieu?.numCirco ?? 0),
      profession: a.profession?.libelleCourant ?? null,
      photo_url: null,
      actif: true,
    });
  }

  if (sansGroupe.length > 0) {
    console.warn(`  ⚠️  ${sansGroupe.length} député(s) sans groupe GP (non-inscrits ?) :`);
    sansGroupe.slice(0, 5).forEach(d => console.warn(`     • ${d}`));
    if (sansGroupe.length > 5) console.warn(`     ... et ${sansGroupe.length - 5} autres\n`);
    else console.warn();
  }

  console.log(`  Insertion de ${rows.length} députés dans dim_depute...`);
  await batchUpsert("dim_depute", rows, "uid_an");
  console.log(`  ✅ ${rows.length} députés traités\n`);

  // ── Historique groupe initial ──
  // On stocke le groupe de chaque député au 2024-07-18 (début 17e législature).
  // Si un député change de groupe plus tard, on fermera cette ligne (date_fin)
  // et on créera une nouvelle entrée — garantissant l'immuabilité historique.
  const { data: enDB, error } = await supabase
    .from("dim_depute")
    .select("id, groupe_id")
    .in("uid_an", rows.map(r => r.uid_an));

  if (error) throw new Error(`Récupération IDs: ${error.message}`);

  const histo = (enDB ?? []).map(d => ({
    depute_id: d.id,
    groupe_id: d.groupe_id,
    date_debut: LEGISLATURE_START,
    date_fin: null,
  }));

  console.log(`  Insertion de ${histo.length} entrées dans dim_depute_groupe_historique...`);
  await batchUpsert("dim_depute_groupe_historique", histo, "depute_id,date_debut");
  console.log(`  ✅ Historique inséré`);
}

// ─── 5. Vérification ─────────────────────────────────────────────────────────
async function verifStats(): Promise<void> {
  console.log("\n📊 Étape 3/3 — Vérification dans Supabase...\n");

  const { data: groupes } = await supabase
    .from("dim_groupe")
    .select("sigle, nom_complet, nb_sieges, couleur_hex")
    .eq("actif", true)
    .order("sigle");

  const { count: nbDep } = await supabase
    .from("dim_depute")
    .select("*", { count: "exact", head: true })
    .eq("actif", true);

  const { count: nbHist } = await supabase
    .from("dim_depute_groupe_historique")
    .select("*", { count: "exact", head: true });

  console.log(`  dim_groupe                   : ${groupes?.length ?? 0} groupes`);
  groupes?.forEach(g => {
    const couleurOk = g.couleur_hex !== "#888888" ? "" : " ⚠️  couleur manquante";
    const sieges = g.nb_sieges > 0 ? `${g.nb_sieges} sièges` : "⚠️  nb_sieges=0";
    console.log(`    ${g.sigle.padEnd(12)} ${g.nom_complet.padEnd(50)} ${sieges}${couleurOk}`);
  });
  console.log(`\n  dim_depute                   : ${nbDep ?? 0} députés actifs`);
  console.log(`  dim_depute_groupe_historique : ${nbHist ?? 0} entrées`);

  if ((nbDep ?? 0) < 500) console.warn("\n  ⚠️  Moins de 500 députés — vérifier le parsing");
  if ((groupes?.length ?? 0) < 8) console.warn("  ⚠️  Moins de 8 groupes — vérifier codeType = GP");
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log(" 01-fetch-deputes.ts v4 — AMO10, Open Data AN         ");
  console.log("══════════════════════════════════════════════════════\n");

  const zip = await downloadZip();
  const { acteurs, organes } = await parseData(zip);
  const groupeMap = await upsertGroupes(organes, acteurs);
  await upsertDeputes(acteurs, groupeMap);
  await verifStats();

  console.log("\n══════════════════════════════════════════════════════");
  console.log(" ✔️  TERMINÉ");
  console.log("══════════════════════════════════════════════════════");
  console.log("\n🔍 Actions manuelles dans Supabase Table Editor :");
  console.log("  1. dim_groupe → vérifier les sigles (colonne sigle)");
  console.log("     Groupes avec ⚠️  = sigle non reconnu dans COULEURS_PAR_SIGLE");
  console.log("     → ajouter le sigle réel dans le script et relancer");
  console.log("  2. dim_groupe → nb_sieges est maintenant calculé automatiquement !");
  console.log("  3. Prochaine étape : npx tsx scripts/02-extract-promesses.ts");
}

main().catch(err => {
  console.error("\n💥 Erreur :", err.message ?? err);
  process.exit(1);
});
