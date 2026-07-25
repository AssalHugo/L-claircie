/**
 * 04-verify-etl-mapping.ts
 * ------------------------
 * Vérifie hors ligne que le mapping ETL Open Data AN → schéma Supabase est correct,
 * SANS toucher à la base ni appeler Gemini.
 *
 * Le script rejoue la logique pure de `supabase/functions/etl-nightly/lib.ts` sur le
 * corpus réel des scrutins de la 17e législature et contrôle les invariants du schéma
 * (`civic_tech.sql`) : colonnes NOT NULL renseignées, types, longueurs varchar,
 * couverture des valeurs de `sort.code`, cohérence des votes nominatifs.
 *
 * C'est le garde-fou du bug qui rendait l'ETL muet : les colonnes NOT NULL
 * `numero`, `titre` et `sort_adopte` étaient absentes de l'INSERT, chaque insertion
 * échouait, et le run se terminait quand même en "success".
 *
 * Usage :
 *   npx tsx scripts/04-verify-etl-mapping.ts
 *
 *   # Réutiliser un dossier déjà décompressé (évite un téléchargement de 26 Mo)
 *   SCRUTINS_DIR=/chemin/vers/json npx tsx scripts/04-verify-etl-mapping.ts
 *
 *   # Limiter le nombre de scrutins analysés (itération rapide)
 *   SCRUTINS_LIMIT=500 npx tsx scripts/04-verify-etl-mapping.ts
 *
 * Code de sortie : 0 si tous les contrôles passent, 1 sinon.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";

import {
  buildClassificationRows,
  buildScrutinRow,
  buildScrutinText,
  extractVoteRows,
  isAdopte,
  toNumber,
  validateClassifications,
  type ClassificationBrute,
  type DeputeRef,
  type ScrutinAN,
  type ScrutinFile,
} from "../supabase/functions/etl-nightly/lib.ts";

const ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip";

const SCRUTINS_DIR = process.env.SCRUTINS_DIR ?? null;
const SCRUTINS_LIMIT = process.env.SCRUTINS_LIMIT
  ? parseInt(process.env.SCRUTINS_LIMIT, 10)
  : Infinity;

// Colonnes NOT NULL de fact_scrutin d'après civic_tech.sql (hors id et defaults).
// C'est la liste que l'ancien INSERT violait.
const FACT_SCRUTIN_NOT_NULL = [
  "uid_an",
  "numero",
  "legislature",
  "titre",
  "objet",
  "date_scrutin",
  "sort_adopte",
] as const;

// Limites varchar du schéma
const MAX_LEN_UID_AN = 50;
const MAX_LEN_TITRE = 500;
const MAX_LEN_URL_AN = 500;

// ─── Rapport ────────────────────────────────────────────────────────────────

interface Check {
  nom: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function assert(nom: string, ok: boolean, detail: string): void {
  checks.push({ nom, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${nom.padEnd(52)} ${detail}`);
}

// ─── Lecture du corpus ──────────────────────────────────────────────────────

const inflateRaw = promisify(zlib.inflateRaw);

/** Parser ZIP natif — même algorithme que 01-fetch-deputes.ts */
async function parseZip(buf: Buffer): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    if (compSize > 0 && !name.endsWith("/") && name.endsWith(".json")) {
      try {
        const data = method === 0
          ? compressed
          : method === 8 ? (await inflateRaw(compressed) as Buffer) : null;
        if (data) out.push({ name, text: data.toString("utf8") });
      } catch { /* corrompu, ignoré */ }
    }
    i = dataStart + compSize;
  }
  return out;
}

async function loadScrutins(): Promise<ScrutinAN[]> {
  const textes: string[] = [];

  if (SCRUTINS_DIR) {
    console.log(`📂 Lecture depuis ${SCRUTINS_DIR}`);
    const files = fs.readdirSync(SCRUTINS_DIR).filter((f: string) => f.endsWith(".json"));
    for (const f of files) {
      textes.push(fs.readFileSync(path.join(SCRUTINS_DIR, f), "utf-8"));
      if (textes.length >= SCRUTINS_LIMIT) break;
    }
  } else {
    console.log(`📥 Téléchargement ${ZIP_URL}`);
    const res = await fetch(ZIP_URL, { headers: { "User-Agent": "LEclaircie-Verify/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`   ${(buf.length / 1024 / 1024).toFixed(1)} Mo reçus, décompression...`);
    const entries = await parseZip(buf);
    for (const e of entries) {
      textes.push(e.text);
      if (textes.length >= SCRUTINS_LIMIT) break;
    }
  }

  const scrutins: ScrutinAN[] = [];
  let illisibles = 0;
  for (const t of textes) {
    try {
      const s = (JSON.parse(t) as ScrutinFile).scrutin;
      if (s?.uid) scrutins.push(s);
    } catch { illisibles++; }
  }
  console.log(`   ${scrutins.length} scrutins chargés (${illisibles} illisibles)\n`);
  return scrutins;
}

// ─── Contrôle 1 : mapping fact_scrutin ──────────────────────────────────────

function verifierMappingScrutin(scrutins: ScrutinAN[]): void {
  console.log("── Contrôle 1 : mapping fact_scrutin ──");

  const manquants = new Map<string, number>();
  let titreTropLong = 0;
  let uidTropLong = 0;
  let urlTropLongue = 0;
  let numeroInvalide = 0;
  let dateInvalide = 0;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  for (const s of scrutins) {
    const row = buildScrutinRow(s);
    const asRecord = row as unknown as Record<string, unknown>;

    for (const col of FACT_SCRUTIN_NOT_NULL) {
      const v = asRecord[col];
      if (v === null || v === undefined || v === "") {
        manquants.set(col, (manquants.get(col) ?? 0) + 1);
      }
    }
    if (row.titre.length > MAX_LEN_TITRE) titreTropLong++;
    if (row.uid_an.length > MAX_LEN_UID_AN) uidTropLong++;
    if (row.url_an.length > MAX_LEN_URL_AN) urlTropLongue++;
    if (!Number.isInteger(row.numero) || row.numero <= 0) numeroInvalide++;
    if (!dateRe.test(row.date_scrutin)) dateInvalide++;
  }

  const detailManquants = manquants.size === 0
    ? `les ${FACT_SCRUTIN_NOT_NULL.length} colonnes NOT NULL sont renseignées`
    : [...manquants.entries()].map(([c, n]) => `${c}=${n}`).join(", ");

  assert("Colonnes NOT NULL de fact_scrutin", manquants.size === 0, detailManquants);
  assert("numero entier > 0", numeroInvalide === 0, `${numeroInvalide} invalide(s)`);
  assert("date_scrutin au format YYYY-MM-DD", dateInvalide === 0, `${dateInvalide} invalide(s)`);
  assert("titre ≤ 500 caractères", titreTropLong === 0, `${titreTropLong} dépassement(s)`);
  assert("uid_an ≤ 50 caractères", uidTropLong === 0, `${uidTropLong} dépassement(s)`);
  assert("url_an ≤ 500 caractères", urlTropLongue === 0, `${urlTropLongue} dépassement(s)`);
}

// ─── Contrôle 2 : sort_adopte ───────────────────────────────────────────────

function verifierSortAdopte(scrutins: ScrutinAN[]): void {
  console.log("\n── Contrôle 2 : sort_adopte ──");

  const codes = new Map<string, number>();
  let fallback = 0;
  let desaccordAnnonce = 0;

  for (const s of scrutins) {
    const code = (s.sort?.code ?? "").toLowerCase();
    codes.set(code || "(vide)", (codes.get(code || "(vide)") ?? 0) + 1);
    if (!code.startsWith("adopt") && !code.startsWith("rejet")) fallback++;

    // Contre-vérification indépendante via l'annonce officielle du perchoir
    const annonce = (s.syntheseVote?.annonce ?? "").toLowerCase();
    if (annonce) {
      const adopteSelonAnnonce = annonce.includes("adopt") && !annonce.includes("n'a pas");
      if (adopteSelonAnnonce !== isAdopte(s)) desaccordAnnonce++;
    }
  }

  const repartition = [...codes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}:${n}`)
    .join(" | ");

  assert("Toutes les valeurs de sort.code sont reconnues", fallback === 0, `repli utilisé ${fallback}×`);
  assert("sort_adopte cohérent avec syntheseVote.annonce", desaccordAnnonce === 0, `${desaccordAnnonce} désaccord(s)`);
  console.log(`     répartition sort.code → ${repartition}`);
}

// ─── Contrôle 3 : extraction des votes ──────────────────────────────────────

/** Compte les votants d'un scrutin indépendamment de extractVoteRows(). */
function compterVotantsIndependamment(s: ScrutinAN): number {
  const asArray = <T>(v: T | T[] | null | undefined): T[] =>
    !v ? [] : Array.isArray(v) ? v : [v];

  let n = 0;
  for (const g of asArray(s.ventilationVotes?.organe?.groupes?.groupe)) {
    const dn = g.vote?.decompteNominatif;
    if (!dn) continue;
    for (const cle of ["pours", "contres", "abstentions", "nonVotants", "nonVotantsVolontaires"] as const) {
      const entry = dn[cle];
      if (entry) n += asArray(entry.votant).length;
    }
  }
  return n;
}

function verifierExtractionVotes(scrutins: ScrutinAN[]): void {
  console.log("\n── Contrôle 3 : extraction des votes nominatifs ──");

  // Table des députés synthétique : tous les acteurRef du corpus sont mappés.
  const deputeByUidAN = new Map<string, DeputeRef>();
  const asArray = <T>(v: T | T[] | null | undefined): T[] =>
    !v ? [] : Array.isArray(v) ? v : [v];

  for (const s of scrutins) {
    for (const g of asArray(s.ventilationVotes?.organe?.groupes?.groupe)) {
      const dn = g.vote?.decompteNominatif;
      if (!dn) continue;
      for (const cle of ["pours", "contres", "abstentions", "nonVotants", "nonVotantsVolontaires"] as const) {
        const entry = dn[cle];
        if (!entry) continue;
        for (const v of asArray(entry.votant)) {
          if (v.acteurRef && !deputeByUidAN.has(v.acteurRef)) {
            deputeByUidAN.set(v.acteurRef, {
              id: deputeByUidAN.size + 1,
              uid_an: v.acteurRef,
              groupe_id: 1,
            });
          }
        }
      }
    }
  }

  let totalExtrait = 0;
  let totalAttendu = 0;
  let ecarts = 0;
  let positionsInvalides = 0;
  const positions = new Map<string, number>();

  for (const s of scrutins) {
    const attendu = compterVotantsIndependamment(s);
    const rows = extractVoteRows(s, 1, deputeByUidAN);
    totalAttendu += attendu;
    totalExtrait += rows.length;
    if (rows.length !== attendu) ecarts++;

    for (const r of rows) {
      const p = r.position_vote;
      if (p !== 1 && p !== -1 && p !== 0 && p !== null) positionsInvalides++;
      positions.set(String(p), (positions.get(String(p)) ?? 0) + 1);
    }
  }

  assert(
    "Aucun votant perdu à l'extraction",
    ecarts === 0 && totalExtrait === totalAttendu,
    `${totalExtrait} extraits / ${totalAttendu} attendus (${ecarts} scrutin(s) en écart)`,
  );
  assert("position_vote ∈ {1, -1, 0, null}", positionsInvalides === 0, `${positionsInvalides} invalide(s)`);
  console.log(
    `     répartition → pour:${positions.get("1") ?? 0} contre:${positions.get("-1") ?? 0} ` +
    `abstention:${positions.get("0") ?? 0} non-votant:${positions.get("null") ?? 0}`,
  );

  // Un député non présent en base doit être ignoré silencieusement, pas produire
  // une ligne orpheline qui violerait la clé étrangère depute_id.
  const mapPartielle = new Map([...deputeByUidAN.entries()].slice(0, 1));
  const rowsPartiels = scrutins.slice(0, 50).flatMap((s) => extractVoteRows(s, 1, mapPartielle));
  const orphelins = rowsPartiels.filter((r) => r.depute_id !== 1).length;
  assert("Députés inconnus ignorés (pas de FK orpheline)", orphelins === 0, `${orphelins} orphelin(s)`);
}

// ─── Contrôle 4 : texte envoyé au LLM ───────────────────────────────────────

function verifierTexteLlm(scrutins: ScrutinAN[]): void {
  console.log("\n── Contrôle 4 : contexte envoyé au LLM ──");

  let resultatInconnu = 0;
  let objetVide = 0;
  let avecDossier = 0;

  for (const s of scrutins) {
    const texte = buildScrutinText(s);
    // Régression : l'ancienne version lisait des champs inexistants et produisait
    // systématiquement "RÉSULTAT : inconnu (0 pour, 0 contre)".
    if (texte.includes("RÉSULTAT : inconnu")) resultatInconnu++;
    if (/OBJET : Sans objet/.test(texte)) objetVide++;
    if (texte.includes("DOSSIER LÉGISLATIF :")) avecDossier++;
  }

  assert("Résultat du vote toujours renseigné", resultatInconnu === 0, `${resultatInconnu} "inconnu"`);
  assert("Objet du scrutin toujours renseigné", objetVide === 0, `${objetVide} vide(s)`);
  console.log(`     ${avecDossier}/${scrutins.length} scrutins enrichis d'un dossier législatif`);

  console.log("\n     Exemple de contexte transmis au modèle :");
  const exemple = scrutins.find((s) => s.typeVote?.codeTypeVote === "SPS") ?? scrutins[0];
  for (const ligne of buildScrutinText(exemple).split("\n")) {
    console.log(`       │ ${ligne.substring(0, 110)}`);
  }
}

// ─── Contrôle 5 : validation des sorties LLM ────────────────────────────────

function verifierValidationLlm(): void {
  console.log("\n── Contrôle 5 : validation des sorties du LLM ──");

  const validIds = new Set([10, 20, 30]);
  const brutes: ClassificationBrute[] = [
    { promesse_id: 10, polarite: 1, confidence: 0.9, raisonnement: "ok" },
    { promesse_id: 20, polarite: -1, confidence: 0.5, raisonnement: "ok" },
    { promesse_id: 30, polarite: 0, confidence: 0.9, raisonnement: "pas de lien" },   // polarité 0
    { promesse_id: 999, polarite: 1, confidence: 0.9, raisonnement: "hallucination" }, // ID inconnu
    { promesse_id: 10, polarite: -1, confidence: 0.8, raisonnement: "doublon" },       // doublon
    { promesse_id: 20, polarite: 1, confidence: 4.2, raisonnement: "confiance hors bornes" }, // doublon aussi
  ];

  const r = validateClassifications(brutes, validIds);

  assert("Polarité 0 rejetée", r.rejetesPolarite === 1, `${r.rejetesPolarite} rejet(s)`);
  assert("promesse_id halluciné rejeté", r.rejetesInconnus === 1, `${r.rejetesInconnus} rejet(s)`);
  assert("promesse_id en doublon rejeté", r.rejetesDoublons === 2, `${r.rejetesDoublons} rejet(s)`);
  assert("Classifications retenues", r.retenus.length === 2, `${r.retenus.length} retenue(s) sur ${brutes.length}`);

  const rows = buildClassificationRows(r.retenus, 42, "modele-test", "a".repeat(64), 0.7);
  const colonnes = Object.keys(rows[0]).sort();
  const attendues = [
    "confidence_score", "modele_llm", "polarite_llm", "promesse_id", "prompt_hash",
    "raisonnement_llm", "scrutin_id", "statut_publication", "statut_validation",
  ];
  assert(
    "Colonnes llm_classification conformes au schéma",
    JSON.stringify(colonnes) === JSON.stringify(attendues),
    colonnes.join(","),
  );
  assert(
    "Aucune colonne 'statut' fantôme",
    !colonnes.includes("statut"),
    "la colonne réelle est statut_validation",
  );
  assert("modele_llm renseigné (NOT NULL)", rows.every((x) => !!x.modele_llm), "ok");
  assert(
    "confidence_score borné à [0,1] sur 2 décimales",
    rows.every((x) => x.confidence_score >= 0 && x.confidence_score <= 1),
    rows.map((x) => x.confidence_score).join(", "),
  );
  assert(
    "statut_validation dérivé du seuil",
    rows[0].statut_validation === "auto" && rows[1].statut_validation === "review",
    `${rows[0].statut_validation} / ${rows[1].statut_validation}`,
  );

  // Bornage haut : une confiance aberrante (4.2) ne doit pas casser numeric(3,2)
  const horsBornes = buildClassificationRows(
    [{ promesse_id: 10, polarite: 1, confidence: 4.2, raisonnement: "" }],
    1, "m", "h", 0.7,
  );
  assert("Confiance aberrante ramenée à 1.00", horsBornes[0].confidence_score === 1, `${horsBornes[0].confidence_score}`);
}

// ─── Contrôle 6 : helpers de normalisation ──────────────────────────────────

function verifierHelpers(): void {
  console.log("\n── Contrôle 6 : helpers de normalisation ──");

  // L'AN sérialise numero et legislature en chaînes
  assert("toNumber('842') → 842", toNumber("842", 0) === 842, "ok");
  assert("toNumber(undefined) → défaut", toNumber(undefined, 17) === 17, "ok");
  assert("toNumber('abc') → défaut", toNumber("abc", 17) === 17, "ok");

  const adopte = { uid: "x", dateScrutin: "2025-01-01", sort: { code: "adopté" } } as ScrutinAN;
  const rejete = { uid: "x", dateScrutin: "2025-01-01", sort: { code: "rejeté" } } as ScrutinAN;
  const sansCode = {
    uid: "x", dateScrutin: "2025-01-01",
    syntheseVote: { annonce: "L'Assemblée nationale n'a pas adopté" },
  } as ScrutinAN;

  assert("isAdopte('adopté') → true", isAdopte(adopte) === true, "ok");
  assert("isAdopte('rejeté') → false", isAdopte(rejete) === false, "ok");
  assert("isAdopte(repli \"n'a pas adopté\") → false", isAdopte(sansCode) === false, "ok");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════════");
  console.log(" 04-verify-etl-mapping.ts — vérification hors ligne du mapping ETL");
  console.log("════════════════════════════════════════════════════════════════\n");

  const scrutins = await loadScrutins();
  if (scrutins.length === 0) throw new Error("Aucun scrutin chargé");

  verifierMappingScrutin(scrutins);
  verifierSortAdopte(scrutins);
  verifierExtractionVotes(scrutins);
  verifierTexteLlm(scrutins);
  verifierValidationLlm();
  verifierHelpers();

  const echecs = checks.filter((c) => !c.ok);
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(` ${echecs.length === 0 ? "✔️  TOUS LES CONTRÔLES PASSENT" : "❌ ÉCHECS DÉTECTÉS"}`);
  console.log(`    ${checks.length - echecs.length}/${checks.length} contrôles OK sur ${scrutins.length} scrutins`);
  console.log("════════════════════════════════════════════════════════════════");

  if (echecs.length > 0) {
    console.log("\nContrôles en échec :");
    echecs.forEach((c) => console.log(`  • ${c.nom} — ${c.detail}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n💥 Erreur :", err instanceof Error ? err.message : err);
  process.exit(1);
});
