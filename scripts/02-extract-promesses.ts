/**
 * 02-extract-promesses.ts
 * -----------------------
 * Envoie les PDF des programmes politiques à l'API Gemini 2.5 Flash
 * et extrait les promesses électorales structurées dans dim_promesse.
 *
 * STRUCTURE ATTENDUE des fichiers PDF :
 *   scripts/data/programmes/
 *     RN/       ← le nom du dossier DOIT correspondre à dim_groupe.sigle
 *       programme-rn-2024.pdf
 *     EPR/
 *       programme-epr-2024.pdf
 *     LFI-NFP/
 *       programme-lfi-nfp-2024.pdf
 *     ... (un dossier par groupe)
 *
 * Un dossier peut contenir PLUSIEURS PDFs (ex: programme + addendum).
 * Chaque PDF sera envoyé séparément à Gemini, les promesses sont agrégées.
 *
 * ⚠️  Limite PDF : Gemini accepte les PDFs inline jusqu'à ~20 MB.
 *     Au-delà, le script t'avertit et saute le fichier.
 *
 * Usage (depuis la racine du projet) :
 *   npx tsx scripts/02-extract-promesses.ts
 *
 *   Pour ne traiter qu'un groupe spécifique :
 *   GROUPE=RN npx tsx scripts/02-extract-promesses.ts
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType, Schema } from "@google/generative-ai";
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
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB — limite Gemini pour les fichiers inline

// Filtre optionnel via variable d'environnement : GROUPE=RN npx tsx ...
const GROUPE_FILTER = process.env.GROUPE ?? null;

// ─── JSON Schema envoyé à Gemini ───────────────────────────────────────────
// Gemini utilise ce schéma pour forcer une sortie JSON stricte.
// Généré dynamiquement en fonction des thèmes de la BDD.
function buildResponseSchema(themesSlugList: string[]) {
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
              description: "Résumé neutre et factuel de la promesse, 5-12 mots, style nominal. Ex: 'Retraite à 60 ans pour les carrières longues'",
            },
            description_longue: {
              type: SchemaType.STRING,
              description: "Description détaillée en 2-4 phrases expliquant le contexte, les bénéficiaires et les modalités concrètes de la promesse.",
            },
            theme_slug: {
              type: SchemaType.STRING,
              enum: themesSlugList,
              description: "Thème principal parmi la liste stricte fournie.",
            },
            source_pdf_page: {
              type: SchemaType.INTEGER,
              description: "Numéro de page exact dans le PDF où se trouve cette promesse. Essentiel pour la vérification.",
            },
            source_citation: {
              type: SchemaType.STRING,
              description: "Extrait textuel brut du programme (max 400 caractères) prouvant directement cette promesse. Citation fidèle, sans modification.",
            },
          },
          required: [
            "intitule_court",
            "description_longue",
            "theme_slug",
            "source_pdf_page",
            "source_citation",
          ],
        },
      },
    },
    required: ["promesses"],
  };
}

// ─── Prompt système envoyé à Gemini ────────────────────────────────────────
// Le ton est délibérément strict et technique pour limiter les hallucinations
// et forcer le modèle à coller au texte source.
function buildSystemPrompt(groupeSigle: string, nomComplet: string): string {
  return `Tu es un analyste politique spécialisé dans les programmes électoraux français.
Tu analyses le programme officiel du parti "${nomComplet}" (sigle: ${groupeSigle}) pour les élections françaises.

TON RÔLE PRÉCIS :
Extraire les PROMESSES ÉLECTORALES CONCRÈTES ET MESURABLES.

RÈGLES STRICTES :

1. EXTRAIRE (promesses concrètes) :
   - Engagements chiffrés : "Retraite à 60 ans", "TVA à 0% sur les produits de première nécessité", "100 000 postes de policiers supplémentaires"
   - Réformes législatives identifiables : "Abroger la réforme des retraites de 2023", "Rétablir le service militaire"
   - Créations/suppressions de structures : "Créer un service public de la petite enfance", "Supprimer la Cour pénale internationale française"
   - Objectifs temporels : "Atteindre le plein emploi d'ici 2027"

2. IGNORER (trop vague pour être mesuré) :
   - Déclarations de valeurs : "Défendre la France", "Protéger les Français", "Respecter la laïcité"
   - Objectifs sans modalités : "Améliorer le système de santé", "Renforcer la sécurité"
   - Diagnostics et critiques : "La politique actuelle a échoué"

3. NEUTRALITÉ ABSOLUE :
   - L'intitule_court doit être NEUTRE, sans jugement de valeur
   - Ne pas reformuler avec un vocabulaire valorisant ou dévalorisant
   - Reproduire la réalité politique du texte sans l'édulcorer ni l'amplifier

4. VOLUME ET QUALITÉ :
   - Vise entre 50 et 150 promesses selon la richesse du document
   - Préfère la qualité à la quantité : une promesse vague ignorée vaut mieux qu'un faux positif
   - Couvre tous les thèmes du programme, pas seulement les sujets phares

5. CITATIONS :
   - La source_citation doit être une CITATION TEXTUELLE EXACTE, copiée mot pour mot depuis le PDF
   - Elle doit être la phrase ou le paragraphe le plus court qui prouve directement la promesse
   - Maximum 400 caractères. Coupe si nécessaire avec "..." mais garde le sens

6. PAGES :
   - source_pdf_page doit être le numéro de page où tu as trouvé la citation
   - En cas de doute entre deux pages, indique la page où commence la promesse

7. RÉFÉRENCES TEMPORELLES :
   - Remplace TOUJOURS les expressions relatives par des années absolues
     dans intitule_court et description_longue.
   - "dès cet été" → "dès l'été [ANNEE_DOCUMENT]"
   - "d'ici la fin de l'année" → "d'ici fin [ANNEE_DOCUMENT]"
   - "dans les 100 premiers jours" → laisser tel quel (relatif à une prise de pouvoir)
   - Si tu ne peux pas déterminer l'année avec certitude → omets la référence temporelle
     plutôt que de laisser une expression ambiguë.


  IMPORTANT: Tu dois traiter l'intégralité du document, de la page 1 à la dernière page.`;
}

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

// ─── Extraction Gemini ─────────────────────────────────────────────────────
async function extractPromessesFromPDF(
  pdfPath: string,
  groupeSigle: string,
  nomComplet: string,
  schema: Schema,
  themesSlugList: string[]
): Promise<PromesseExtraite[]> {
  const stats = fs.statSync(pdfPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  const filename = path.basename(pdfPath);

  console.log(`  📄 Traitement : ${filename} (${sizeMB} MB)`);

  if (stats.size > MAX_PDF_SIZE) {
    console.warn(`  ⚠️  Fichier trop grand (${sizeMB} MB > 20 MB). Passage au suivant.`);
    console.warn("     → Compresse le PDF ou utilise Gemini Files API pour les gros fichiers.");
    return [];
  }

  // Lecture du PDF en base64 pour envoi inline à Gemini
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBytes.toString("base64");

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      // Force le modèle à retourner du JSON strictement conforme au schéma
      responseMimeType: "application/json",
      responseSchema: schema,
      // Température 0 = déterministe, pas de créativité, résultats reproductibles
      // C'est OBLIGATOIRE pour un outil civic tech : même PDF → même résultat
      temperature: 0,
    },
    systemInstruction: buildSystemPrompt(groupeSigle, nomComplet),
  });

  console.log("  🤖 Envoi à Gemini 2.5 Flash... (peut prendre 20-60s selon la taille)");
  const startTime = Date.now();

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBase64,
      },
    },
    {
      text: "Analyse ce programme électoral complet et extrais toutes les promesses concrètes et mesurables selon les instructions.",
    },
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const response = result.response;

  // Informations de consommation de tokens (facturation Gemini)
  const usage = response.usageMetadata;
  if (usage) {
    const inputTokens = usage.promptTokenCount ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? 0;
    // Tarif Gemini 2.5 Flash : $0.30/1M input, $2.50/1M output (sans cache)
    const cost = (inputTokens * 0.30 + outputTokens * 2.50) / 1_000_000;
    console.log(`  ⏱️  ${elapsed}s | Tokens: ${inputTokens} in + ${outputTokens} out | Coût estimé: $${cost.toFixed(4)}`);
  } else {
    console.log(`  ⏱️  ${elapsed}s`);
  }

  const text = response.text();

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(text) as GeminiResponse;
  } catch {
    console.error("  ❌ Impossible de parser la réponse JSON de Gemini");
    console.error("  Réponse brute (500 premiers chars) :", text.substring(0, 500));
    return [];
  }

  if (!parsed.promesses || !Array.isArray(parsed.promesses)) {
    console.error("  ❌ Structure JSON inattendue : pas de tableau 'promesses'");
    return [];
  }

  // Validation légère : filtre les promesses avec des champs manquants
  const valides = parsed.promesses.filter((p) => {
    if (!p.intitule_court || !p.theme_slug || !p.source_citation) {
      console.warn(`  ⚠️  Promesse ignorée (champs manquants) : ${p.intitule_court ?? "sans titre"}`);
      return false;
    }
    if (!themesSlugList.includes(p.theme_slug)) {
      console.warn(`  ⚠️  Thème inconnu '${p.theme_slug}' pour : ${p.intitule_court}`);
      return false;
    }
    return true;
  });

  console.log(`  ✅ ${valides.length} promesses extraites (${parsed.promesses.length - valides.length} rejetées)`);
  return valides;
}

// ─── Insertion Supabase ────────────────────────────────────────────────────
async function insertPromesses(
  promesses: PromesseExtraite[],
  groupeId: number,
  themeIdBySlug: Map<string, number>,
  sourcePdfNom: string
): Promise<number> {
  if (promesses.length === 0) return 0;

  const rows = promesses.map((p) => ({
    groupe_id: groupeId,
    theme_id: themeIdBySlug.get(p.theme_slug)!,
    intitule_court: p.intitule_court.substring(0, 200),
    description_longue: p.description_longue ?? null,
    source_pdf_nom: sourcePdfNom,
    source_pdf_page: p.source_pdf_page,
    source_citation: p.source_citation.substring(0, 500),
    statut: null,
  }));

  // Pas de clé de conflit unique naturelle sur dim_promesse.
  // On fait un INSERT simple en acceptant les doublons potentiels
  // (en cas de relance, vérifie manuellement les doublons dans Supabase).
  // Une V2 pourrait ajouter un hash(groupe_id + source_citation) comme clé unique.
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await supabase
      .from("dim_promesse")
      .insert(rows.slice(i, i + BATCH))
      .select("id");

    if (error) {
      console.error(`  ❌ Erreur insertion dim_promesse :`, error.message);
      throw error;
    }
    inserted += data?.length ?? 0;
  }
  return inserted;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log(" 02-extract-promesses.ts — Extraction des promesses PDF ");
  console.log("════════════════════════════════════════════════════════\n");

  // ── Vérifier que le dossier data/programmes existe ──
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`❌ Dossier introuvable : ${PDF_DIR}`);
    console.error("   Crée la structure suivante :");
    console.error("   scripts/data/programmes/");
    console.error("     RN/mon-programme-rn.pdf");
    console.error("     EPR/mon-programme-epr.pdf");
    console.error("     ...");
    process.exit(1);
  }

  // ── Charger les groupes depuis Supabase ──
  const { data: groupes, error: gError } = await supabase
    .from("dim_groupe")
    .select("id, sigle, nom_complet")
    .eq("actif", true);

  if (gError || !groupes) throw new Error(`Chargement groupes: ${gError?.message}`);

  const groupeBySlug = new Map(groupes.map((g) => [g.sigle, g]));

  // ── Charger les thèmes depuis Supabase ──
  const { data: themes, error: tError } = await supabase
    .from("dim_theme")
    .select("id, slug");

  if (tError || !themes) throw new Error(`Chargement thèmes: ${tError?.message}`);

  const themeIdBySlug = new Map(themes.map((t) => [t.slug, t.id]));
  const themesSlugList = themes.map((t) => t.slug);
  const responseSchema = buildResponseSchema(themesSlugList);

  // ── Scanner les dossiers de programmes ──
  const dossiers = fs.readdirSync(PDF_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !GROUPE_FILTER || name === GROUPE_FILTER)
    .sort();

  if (dossiers.length === 0) {
    console.warn("⚠️  Aucun dossier de programme trouvé dans", PDF_DIR);
    if (GROUPE_FILTER) console.warn(`   Filtre actif : GROUPE=${GROUPE_FILTER}`);
    process.exit(0);
  }

  console.log(`📁 ${dossiers.length} dossier(s) à traiter : ${dossiers.join(", ")}\n`);

  // ── Traitement groupe par groupe ──
  let totalPromesses = 0;
  const resultats: { groupe: string; fichiers: number; promesses: number }[] = [];

  for (const sigle of dossiers) {
    const groupe = groupeBySlug.get(sigle);
    if (!groupe) {
      console.warn(`⚠️  Groupe "${sigle}" non trouvé dans dim_groupe. Passe le script 01 d'abord.`);
      continue;
    }

    const dossierPath = path.join(PDF_DIR, sigle);
    const pdfs = fs.readdirSync(dossierPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort();

    if (pdfs.length === 0) {
      console.warn(`⚠️  Aucun PDF dans ${dossierPath}`);
      continue;
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(` Groupe : ${groupe.nom_complet} (${sigle})`);
    console.log(` ${pdfs.length} fichier(s) PDF à traiter`);
    console.log("═".repeat(60));

    let promessesGroupe: PromesseExtraite[] = [];

    for (const pdfName of pdfs) {
      const pdfPath = path.join(dossierPath, pdfName);
      const extraites = await extractPromessesFromPDF(pdfPath, sigle, groupe.nom_complet, responseSchema, themesSlugList);
      promessesGroupe = [...promessesGroupe, ...extraites];

      // Pause 2s systématique pour ne pas saturer le quota Gemini
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (promessesGroupe.length === 0) {
      console.warn(`  ⚠️  Aucune promesse extraite pour ${sigle}`);
      continue;
    }

    // Répartition par thème (aperçu visuel avant insertion)
    const parTheme = new Map<string, number>();
    promessesGroupe.forEach((p) => parTheme.set(p.theme_slug, (parTheme.get(p.theme_slug) ?? 0) + 1));
    console.log("\n  Répartition par thème :");
    [...parTheme.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([slug, nb]) => console.log(`    ${slug.padEnd(18)} : ${nb} promesses`));

    // Nom de fichier représentatif pour source_pdf_nom
    const sourcePdfNom = pdfs.length === 1 ? pdfs[0] : `${sigle}-${pdfs.length}-documents`;

    const inserted = await insertPromesses(
      promessesGroupe,
      groupe.id,
      themeIdBySlug,
      sourcePdfNom
    );

    totalPromesses += inserted;
    resultats.push({ groupe: sigle, fichiers: pdfs.length, promesses: inserted });
    console.log(`\n  ✅ ${inserted} promesses insérées dans dim_promesse`);
  }

  // ── Résumé final ──
  console.log("\n\n════════════════════════════════════════════════════════");
  console.log(" ✔️  RÉSUMÉ FINAL");
  console.log("════════════════════════════════════════════════════════\n");
  resultats.forEach((r) =>
    console.log(`  ${r.groupe.padEnd(12)}: ${r.promesses} promesses extraites (${r.fichiers} fichier(s))`)
  );
  console.log(`\n  TOTAL : ${totalPromesses} promesses insérées dans dim_promesse\n`);

  console.log("🔍 ÉTAPE SUIVANTE — Validation manuelle obligatoire :");
  console.log("  1. Ouvre Supabase → Table Editor → dim_promesse");
  console.log("  2. Relis CHAQUE promesse, notamment :");
  console.log("     → intitule_court   : neutre ? factuel ? sans biais ?");
  console.log("     → source_citation  : la citation est-elle exacte dans le PDF ?");
  console.log("     → source_pdf_page  : va vérifier sur la bonne page");
  console.log("     → theme_slug       : le thème est-il le bon ?");
  console.log("  3. Modifie/supprime directement dans Supabase ce qui est faux");
  console.log("  4. Une fois satisfait → c'est ta VÉRITÉ FIGÉE. Ne pas retoucher.");
  console.log("\n  ⚠️  Si une promesse est incertaine, passe son statut à 'retiree'");
  console.log("      plutôt que de la supprimer (traçabilité).");
}

main().catch((err) => {
  console.error("\n💥 Erreur inattendue :", err);
  process.exit(1);
});
