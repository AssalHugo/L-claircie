/**
 * 02-extract-promesses.ts
 * -----------------------
 * Envoie les PDF des programmes politiques à l'API Gemini 2.5 Flash
 * et extrait les promesses électorales structurées dans dim_promesse.
 *
 * STRUCTURE ATTENDUE des fichiers PDF :
 *   scripts/data/programmes/
 *     RN/
 *       programme-rn-2024.pdf
 *     EPR/
 *       programme-epr-2024.pdf
 *     _shared/                      ← PDFs partagés entre plusieurs groupes
 *       nfp-2024.pdf
 *
 *   scripts/data/programmes/partage.json   ← déclare les PDFs partagés
 *
 * OPTIMISATION PDFs PARTAGÉS (ex: programme NFP commun à LFI-NFP, SOC, ECOS, GDR) :
 *   Au lieu d'appeler Gemini 4 fois avec le même PDF, on l'appelle UNE SEULE FOIS,
 *   puis on duplique les promesses extraites pour chaque groupe concerné.
 *   Économie : 3 appels Gemini sur 4 = ~75% de coût en moins sur les PDFs partagés.
 *
 *   Format de partage.json :
 *   [
 *     {
 *       "pdfs": [                               ← un ou plusieurs PDFs
 *         "_shared/nfp-2024.pdf",
 *         "_shared/nfp-annexe-fiscale.pdf"
 *       ],
 *       "groupes": ["LFI-NFP", "SOC", "ECOS", "GDR"],
 *       "annee": 2024,
 *       "description": "Programme commun du Nouveau Front Populaire"
 *     }
 *   ]
 *
 * Un dossier peut aussi contenir des PDFs spécifiques ET un PDF partagé.
 * Les promesses sont agrégées, le dedupe_hash évite les doublons à la relance.
 *
 * Supports .pdf et .txt (texte extrait — voir pdf-to-text.py pour les PDFs lourds)
 *
 * Usage :
 *   npx tsx scripts/02-extract-promesses.ts          ← tous les groupes
 *   GROUPE=RN npx tsx scripts/02-extract-promesses.ts ← un seul groupe
 *   ANNEE=2024 npx tsx scripts/02-extract-promesses.ts ← override année
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType, Schema } from "@google/generative-ai";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: ".env.local" });

// ─── Validation env ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE || !GEMINI_API_KEY) {
  console.error("❌ Variables manquantes dans .env.local :");
  if (!SUPABASE_URL) console.error("   → NEXT_PUBLIC_SUPABASE_URL");
  if (!SUPABASE_SERVICE) console.error("   → SUPABASE_SERVICE_ROLE_KEY");
  if (!GEMINI_API_KEY) console.error("   → GEMINI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── Configuration ─────────────────────────────────────────────────────────
const PDF_DIR = path.join("scripts", "data", "programmes");
const PARTAGE_FILE = path.join(PDF_DIR, "partage.json");
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const GROUPE_FILTER = process.env.GROUPE ?? null;
const ANNEE_OVERRIDE = process.env.ANNEE ? parseInt(process.env.ANNEE, 10) : null;

// ─── Types ─────────────────────────────────────────────────────────────────
interface PromesseExtraite {
  intitule_court: string;
  description_longue: string;
  theme_slug: string;
  source_pdf_page: number;
  source_citation: string;
}

interface GeminiResponse {
  promesses: PromesseExtraite[];
}

interface PartageConfig {
  pdfs: string[];   // un ou plusieurs PDFs partagés, ex: ["_shared/nfp-2024.pdf", "_shared/nfp-addendum.pdf"]
  groupes: string[];   // sigles des groupes qui partagent ces PDFs
  annee?: number;
  description?: string;
}

// ─── JSON Schema Gemini ─────────────────────────────────────────────────────
function buildResponseSchema(themesSlugList: string[]): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      promesses: {
        type: SchemaType.ARRAY,
        description: "Liste des promesses électorales concrètes extraites du programme",
        items: {
          type: SchemaType.OBJECT,
          properties: {
            intitule_court: {
              type: SchemaType.STRING,
              description: "Résumé neutre et factuel de la promesse, 5-12 mots, style nominal.",
            },
            description_longue: {
              type: SchemaType.STRING,
              description: "Description détaillée en 2-4 phrases : contexte, bénéficiaires, modalités concrètes.",
            },
            theme_slug: {
              type: SchemaType.STRING,
              enum: themesSlugList,
              description: "Thème principal parmi la liste stricte fournie.",
            },
            source_pdf_page: {
              type: SchemaType.INTEGER,
              description: "Numéro de page exact dans le PDF où se trouve cette promesse.",
            },
            source_citation: {
              type: SchemaType.STRING,
              description: "Citation textuelle exacte du programme (max 400 caractères), copiée mot pour mot.",
            },
          },
          required: ["intitule_court", "description_longue", "theme_slug", "source_pdf_page", "source_citation"],
        },
      },
    },
    required: ["promesses"],
  } as Schema;
}

// ─── Prompt système ─────────────────────────────────────────────────────────
function buildSystemPrompt(groupeSigle: string, nomComplet: string, anneeDoc: number): string {
  return `Tu es un analyste politique spécialisé dans les programmes électoraux français.
Tu analyses le programme officiel du parti "${nomComplet}" (sigle: ${groupeSigle}), publié en ${anneeDoc}.

TON RÔLE PRÉCIS : Extraire les PROMESSES ÉLECTORALES CONCRÈTES ET MESURABLES.

RÈGLES STRICTES :

1. EXTRAIRE (promesses concrètes) :
   - Engagements chiffrés : "Retraite à 60 ans", "TVA à 0% sur les produits essentiels"
   - Réformes législatives identifiables : "Abroger la réforme des retraites de 2023"
   - Créations/suppressions : "Créer un service public de la petite enfance"
   - Objectifs temporels précis : "Atteindre le plein emploi d'ici 2027"

2. IGNORER (trop vague) :
   - Déclarations de valeurs : "Défendre la France", "Protéger les Français"
   - Objectifs sans modalités : "Améliorer le système de santé"
   - Diagnostics et critiques de l'existant

3. NEUTRALITÉ ABSOLUE :
   - intitule_court doit être NEUTRE, sans jugement de valeur
   - Ne pas reformuler avec un vocabulaire valorisant ou dévalorisant

4. VOLUME ET QUALITÉ :
   - Vise entre 50 et 150 promesses selon la richesse du document
   - Couvre tous les thèmes, pas seulement les sujets phares

5. CITATIONS :
   - Citation TEXTUELLE EXACTE, copiée mot pour mot depuis le PDF
   - Maximum 400 caractères

6. RÉFÉRENCES TEMPORELLES :
   - "cet été" → "l'été ${anneeDoc}"
   - "cette année" → "${anneeDoc}"
   - "l'année prochaine" → "${anneeDoc + 1}"
   - "dans les 100 premiers jours" → laisser tel quel
   - Si incertain → omettre la référence plutôt que laisser ambigu

IMPORTANT : Traiter l'intégralité du document, de la page 1 à la dernière page.`;
}

// ─── Extraction Gemini ──────────────────────────────────────────────────────
async function extractPromessesFromFile(
  filePath: string,
  groupeSigle: string,
  nomComplet: string,
  schema: Schema,
  themesSlugList: string[],
  anneeDoc: number
): Promise<PromesseExtraite[]> {
  const stats = fs.statSync(filePath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  const filename = path.basename(filePath);
  const isTxt = filePath.endsWith(".txt");

  console.log(`  📄 ${filename} (${sizeMB} MB) ${isTxt ? "[texte extrait]" : "[PDF]"}`);

  if (stats.size > MAX_FILE_SIZE) {
    console.warn(`  ⚠️  Fichier trop grand (${sizeMB} MB > 25 MB).`);
    console.warn("     → Lance python scripts/pdf-to-text.py sur ce fichier d'abord.");
    return [];
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
    },
    systemInstruction: buildSystemPrompt(groupeSigle, nomComplet, anneeDoc),
  });

  console.log("  🤖 Envoi à Gemini 2.5 Flash...");
  const startTime = Date.now();

  let result: Awaited<ReturnType<typeof model.generateContent>>;

  if (isTxt) {
    // Fichier texte : envoi direct comme prompt texte
    const textContent = fs.readFileSync(filePath, "utf-8");
    result = await model.generateContent([
      { text: `Programme électoral de ${nomComplet} :\n\n${textContent}` },
      { text: "Analyse ce programme et extrais toutes les promesses concrètes et mesurables." },
    ]);
  } else {
    // PDF : envoi en base64 inline
    const pdfBase64 = fs.readFileSync(filePath).toString("base64");
    result = await model.generateContent([
      { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
      { text: "Analyse ce programme électoral complet et extrais toutes les promesses concrètes et mesurables." },
    ]);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const usage = result.response.usageMetadata;

  if (usage) {
    const inputT = usage.promptTokenCount ?? 0;
    const outputT = usage.candidatesTokenCount ?? 0;
    const cost = (inputT * 0.30 + outputT * 2.50) / 1_000_000;
    console.log(`  ⏱️  ${elapsed}s | ${inputT} in + ${outputT} out | $${cost.toFixed(4)}`);
  } else {
    console.log(`  ⏱️  ${elapsed}s`);
  }

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(result.response.text()) as GeminiResponse;
  } catch {
    console.error("  ❌ Impossible de parser la réponse JSON");
    return [];
  }

  const valides = (parsed.promesses ?? []).filter(p => {
    if (!p.intitule_court || !p.theme_slug || !p.source_citation) return false;
    if (!themesSlugList.includes(p.theme_slug)) {
      console.warn(`  ⚠️  Thème inconnu '${p.theme_slug}' — ignoré`);
      return false;
    }
    return true;
  });

  console.log(`  ✅ ${valides.length} promesses extraites`);
  return valides;
}

// ─── Hash de déduplication ──────────────────────────────────────────────────
function computeDedupeHash(groupeId: number, sourceCitation: string): string {
  return crypto
    .createHash("sha256")
    .update(`${groupeId}||${sourceCitation}`)
    .digest("hex");
}

// ─── Insertion Supabase ─────────────────────────────────────────────────────
async function insertPromesses(
  promesses: PromesseExtraite[],
  groupeId: number,
  themeIdBySlug: Map<string, number>,
  sourcePdfNom: string,
  sourcePdfAnnee: number
): Promise<number> {
  if (promesses.length === 0) return 0;

  const rows = promesses.map(p => {
    const citation = p.source_citation.substring(0, 500);
    return {
      groupe_id: groupeId,
      theme_id: themeIdBySlug.get(p.theme_slug)!,
      intitule_court: p.intitule_court.substring(0, 200),
      description_longue: p.description_longue ?? null,
      source_pdf_nom: sourcePdfNom,
      source_pdf_page: p.source_pdf_page,
      source_pdf_annee: sourcePdfAnnee,
      source_citation: citation,
      dedupe_hash: computeDedupeHash(groupeId, citation),
      statut: null,
    };
  });

  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await supabase
      .from("dim_promesse")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "dedupe_hash", ignoreDuplicates: true })
      .select("id");

    if (error) { console.error("  ❌ Erreur upsert :", error.message); throw error; }
    inserted += data?.length ?? 0;
  }
  return inserted;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log(" 02-extract-promesses.ts — Extraction des promesses PDF ");
  console.log("════════════════════════════════════════════════════════\n");

  if (!fs.existsSync(PDF_DIR)) {
    console.error(`❌ Dossier introuvable : ${PDF_DIR}`);
    process.exit(1);
  }

  // ── Chargement BDD ──
  const { data: groupes, error: gError } = await supabase
    .from("dim_groupe").select("id, sigle, nom_complet").eq("actif", true);
  if (gError || !groupes) throw new Error(`Chargement groupes: ${gError?.message}`);
  const groupeBySlug = new Map(groupes.map(g => [g.sigle, g]));

  const { data: themes, error: tError } = await supabase
    .from("dim_theme").select("id, slug");
  if (tError || !themes) throw new Error(`Chargement thèmes: ${tError?.message}`);
  const themeIdBySlug = new Map(themes.map(t => [t.slug, t.id]));
  const themesSlugList = themes.map(t => t.slug);
  const responseSchema = buildResponseSchema(themesSlugList);

  let totalPromesses = 0;
  const resultats: { groupe: string; source: string; promesses: number }[] = [];

  // ════════════════════════════════════════════════════════
  // ÉTAPE 1 — PDFs PARTAGÉS (un seul appel Gemini → N groupes)
  // ════════════════════════════════════════════════════════
  if (fs.existsSync(PARTAGE_FILE)) {
    const configs = JSON.parse(fs.readFileSync(PARTAGE_FILE, "utf-8")) as PartageConfig[];

    for (const config of configs) {
      // Filtre GROUPE= : ne traite que si au moins un des groupes partagés est concerné
      if (GROUPE_FILTER && !config.groupes.includes(GROUPE_FILTER)) continue;

      const annee = ANNEE_OVERRIDE ?? config.annee ?? new Date().getFullYear();
      const sigles = GROUPE_FILTER ? config.groupes.filter(s => s === GROUPE_FILTER) : config.groupes;

      console.log(`\n${"═".repeat(60)}`);
      console.log(` 📎 PDF(S) PARTAGÉ(S) : ${config.description ?? config.pdfs.join(", ")}`);
      console.log(` Groupes concernés : ${sigles.join(", ")} (${sigles.length})`);
      console.log(` ⚡ ${config.pdfs.length} fichier(s), Gemini appelé une fois par fichier pour ${sigles.length} groupe(s)`);
      console.log("═".repeat(60));

      const premierGroupe = groupeBySlug.get(sigles[0]);
      if (!premierGroupe) {
        console.warn(`⚠️  Groupe ${sigles[0]} introuvable en BDD`);
        continue;
      }

      // ── Appel Gemini pour CHAQUE PDF de la config (mais une seule fois par PDF) ──
      let promessesExtraites: PromesseExtraite[] = [];
      for (const pdfRelPath of config.pdfs) {
        // Priorité au .txt si le PDF a été converti via pdf-to-text.py
        const txtRelPath = pdfRelPath.replace(/\.pdf$/i, ".txt");
        const txtFullPath = path.join(PDF_DIR, txtRelPath);
        const actualPath = fs.existsSync(txtFullPath) ? txtRelPath : pdfRelPath;
        const filePath = path.join(PDF_DIR, actualPath);
        if (actualPath !== pdfRelPath) {
          console.log(`  ⏭️  ${path.basename(pdfRelPath)} → version .txt utilisée`);
        }
        if (!fs.existsSync(filePath)) {
          console.warn(`  ⚠️  Fichier introuvable : ${filePath} — ignoré`);
          continue;
        }
        const nomGenerique = config.description ?? premierGroupe.nom_complet;
        const extraites = await extractPromessesFromFile(
          filePath,
          sigles.join("/"),
          nomGenerique,
          responseSchema,
          themesSlugList,
          annee
        );
        promessesExtraites = [...promessesExtraites, ...extraites];
        await new Promise(r => setTimeout(r, 2000));
      }

      if (promessesExtraites.length === 0) {
        console.warn("  ⚠️  Aucune promesse extraite");
        continue;
      }

      // Répartition par thème
      const parTheme = new Map<string, number>();
      promessesExtraites.forEach(p => parTheme.set(p.theme_slug, (parTheme.get(p.theme_slug) ?? 0) + 1));
      console.log("\n  Répartition par thème :");
      [...parTheme.entries()].sort((a, b) => b[1] - a[1])
        .forEach(([slug, nb]) => console.log(`    ${slug.padEnd(18)} : ${nb}`));

      // ── Insertion pour CHAQUE groupe concerné ──
      console.log(`\n  Insertion pour ${sigles.length} groupe(s)...`);
      const sourcePdfNom = config.pdfs.length === 1
        ? path.basename(config.pdfs[0])
        : `${config.description ?? "partage"}-${config.pdfs.length}-docs`;

      for (const sigle of sigles) {
        const groupe = groupeBySlug.get(sigle);
        if (!groupe) {
          console.warn(`  ⚠️  Groupe ${sigle} introuvable en BDD — ignoré`);
          continue;
        }
        const inserted = await insertPromesses(
          promessesExtraites, groupe.id, themeIdBySlug, sourcePdfNom, annee
        );
        totalPromesses += inserted;
        resultats.push({ groupe: sigle, source: `[partagé] ${sourcePdfNom}`, promesses: inserted });
        console.log(`  ✅ ${sigle.padEnd(12)} : ${inserted} promesses insérées`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } else {
    console.log("ℹ️  Pas de fichier partage.json trouvé — PDFs individuels uniquement.");
    console.log(`   (Crée ${PARTAGE_FILE} pour optimiser les PDFs partagés)\n`);
  }

  // ════════════════════════════════════════════════════════
  // ÉTAPE 2 — PDFs INDIVIDUELS (un appel par groupe)
  // ════════════════════════════════════════════════════════

  // Groupes déjà traités via partage (pour ne pas les retraiter s'ils ont aussi un dossier)
  // → On traite quand même leur dossier s'ils ont des PDFs spécifiques en plus du partagé
  const dossiers = fs.readdirSync(PDF_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== "_shared")
    .map(d => d.name)
    .filter(name => !GROUPE_FILTER || name === GROUPE_FILTER)
    .sort();

  for (const sigle of dossiers) {
    const groupe = groupeBySlug.get(sigle);
    if (!groupe) {
      console.warn(`⚠️  Groupe "${sigle}" non trouvé dans dim_groupe`);
      continue;
    }

    const dossierPath = path.join(PDF_DIR, sigle);

    // Accepte .pdf et .txt — priorité au .txt si le PDF a été converti
    const allFiles = fs.readdirSync(dossierPath)
      .filter(f => f.match(/\.(pdf|txt)$/i))
      .sort();
    const txtBases = new Set(
      allFiles.filter(f => f.endsWith(".txt")).map(f => f.replace(/\.txt$/i, ""))
    );
    const fichiers = allFiles.filter(f => {
      if (f.match(/\.pdf$/i)) {
        const base = f.replace(/\.pdf$/i, "");
        if (txtBases.has(base)) {
          console.log(`  ⏭️  ${f} ignoré (version .txt disponible)`);
          return false;
        }
      }
      return true;
    });

    if (fichiers.length === 0) {
      console.warn(`⚠️  Aucun fichier dans ${dossierPath}`);
      continue;
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(` Groupe : ${groupe.nom_complet} (${sigle})`);
    console.log(` ${fichiers.length} fichier(s) à traiter`);
    console.log("═".repeat(60));

    let promessesGroupe: PromesseExtraite[] = [];

    for (const fichier of fichiers) {
      const filePath = path.join(dossierPath, fichier);
      const annee = ANNEE_OVERRIDE ?? inferAnnee(fichier);
      const extraites = await extractPromessesFromFile(
        filePath, sigle, groupe.nom_complet, responseSchema, themesSlugList, annee
      );
      promessesGroupe = [...promessesGroupe, ...extraites];
      await new Promise(r => setTimeout(r, 2000));
    }

    if (promessesGroupe.length === 0) {
      console.warn(`  ⚠️  Aucune promesse extraite pour ${sigle}`);
      continue;
    }

    const parTheme = new Map<string, number>();
    promessesGroupe.forEach(p => parTheme.set(p.theme_slug, (parTheme.get(p.theme_slug) ?? 0) + 1));
    console.log("\n  Répartition par thème :");
    [...parTheme.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([slug, nb]) => console.log(`    ${slug.padEnd(18)} : ${nb}`));

    const annee = ANNEE_OVERRIDE ?? inferAnnee(fichiers[0]);
    const sourcePdfNom = fichiers.length === 1 ? fichiers[0] : `${sigle}-${fichiers.length}-docs`;
    const inserted = await insertPromesses(
      promessesGroupe, groupe.id, themeIdBySlug, sourcePdfNom, annee
    );

    totalPromesses += inserted;
    resultats.push({ groupe: sigle, source: sourcePdfNom, promesses: inserted });
    console.log(`\n  ✅ ${inserted} promesses insérées dans dim_promesse`);
  }

  // ── Résumé ──
  console.log("\n\n════════════════════════════════════════════════════════");
  console.log(" ✔️  RÉSUMÉ FINAL");
  console.log("════════════════════════════════════════════════════════\n");
  resultats.forEach(r =>
    console.log(`  ${r.groupe.padEnd(12)} : ${String(r.promesses).padStart(3)} promesses   (${r.source})`)
  );
  console.log(`\n  TOTAL : ${totalPromesses} promesses insérées\n`);
  console.log("  Prochaine étape : npx tsx scripts/03-review-promesses.ts");
}

/** Déduit l'année d'un document depuis le nom de fichier, ex: "nfp-2024.pdf" → 2024 */
function inferAnnee(filename: string): number {
  const match = filename.match(/20(\d{2})/);
  return match ? parseInt(`20${match[1]}`, 10) : new Date().getFullYear();
}

main().catch(err => {
  console.error("\n💥 Erreur inattendue :", err);
  process.exit(1);
});
