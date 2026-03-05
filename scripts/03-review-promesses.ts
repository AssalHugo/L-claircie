/**
 * 03-review-promesses.ts
 * ----------------------
 * Fait relire les promesses extraites par un second passage Gemini
 * jouant le rôle de relecteur critique.
 *
 * Pour chaque promesse, Gemini évalue 4 critères :
 *   - neutralite  : l'intitulé est-il neutre, sans biais idéologique ?
 *   - concordance : la citation source confirme-t-elle bien la promesse ?
 *   - concretude  : est-ce une vraie promesse mesurable (pas une valeur vague) ?
 *   - temporel    : y a-t-il une référence temporelle ambiguë ("cet été", etc.) ?
 *
 * Résultat :
 *   - score 0-3 problèmes → statut = 'auto'    (validé automatiquement)
 *   - score 1+ problèmes  → statut = 'review'  (à relire manuellement)
 *
 * À la fin, tu n'as à relire QUE les promesses en 'review' dans Supabase.
 *
 * Usage :
 *   npx tsx scripts/03-review-promesses.ts
 *
 *   Pour ne traiter qu'un groupe :
 *   GROUPE=RN npx tsx scripts/03-review-promesses.ts
 *
 *   Pour simuler sans écrire en base (dry run) :
 *   DRY_RUN=1 npx tsx scripts/03-review-promesses.ts
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// ─── Validation env ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE || !GEMINI_API_KEY) {
  console.error("❌ Variables manquantes dans .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const DRY_RUN = process.env.DRY_RUN === "1";
const GROUPE_FILTER = process.env.GROUPE ?? null;

// Nombre de promesses envoyées à Gemini en une seule requête.
// Plus grand = moins d'appels API (moins cher), mais réponses moins précises.
// 20 est un bon équilibre qualité/coût.
const BATCH_SIZE = 20;

// ─── Types ─────────────────────────────────────────────────────────────────
interface PromesseDB {
  id: number;
  intitule_court: string;
  source_citation: string;
  description_longue: string | null;
  groupe_id: number;
}

interface EvaluationGemini {
  id: number;   // ID Supabase de la promesse — clé de retour
  ok_neutralite: boolean; // true = neutre, false = biais détecté
  ok_concordance: boolean; // true = citation confirme la promesse
  ok_concretude: boolean; // true = promesse mesurable
  ok_temporel: boolean; // true = pas de référence temporelle ambiguë
  remarque: string;  // Explication courte si un critère est false, sinon ""
}

interface GeminiBatchResponse {
  evaluations: EvaluationGemini[];
}

// ─── Schema JSON pour Gemini ────────────────────────────────────────────────
const REVIEW_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    evaluations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: {
            type: SchemaType.INTEGER,
            description: "L'id exact de la promesse tel que fourni dans l'input. NE PAS MODIFIER.",
          },
          ok_neutralite: {
            type: SchemaType.BOOLEAN,
            description: "true si l'intitulé est neutre et factuel, false si vocabulaire partisan, péjoratif ou valorisant détecté.",
          },
          ok_concordance: {
            type: SchemaType.BOOLEAN,
            description: "true si la source_citation confirme directement et clairement l'intitulé, false si discordance ou citation trop vague.",
          },
          ok_concretude: {
            type: SchemaType.BOOLEAN,
            description: "true si c'est une promesse concrète et vérifiable (chiffre, réforme identifiable, création/suppression), false si c'est une déclaration d'intention vague.",
          },
          ok_temporel: {
            type: SchemaType.BOOLEAN,
            description: "true si aucune référence temporelle ambiguë, false si expressions comme 'cet été', 'cette année', 'prochainement' sans année précise.",
          },
          remarque: {
            type: SchemaType.STRING,
            description: "Explication courte (max 100 caractères) du ou des problèmes détectés. Chaîne vide si tout est ok.",
          },
        },
        required: ["id", "ok_neutralite", "ok_concordance", "ok_concretude", "ok_temporel", "remarque"],
      },
    },
  },
  required: ["evaluations"],
};

// ─── Prompt système du relecteur ────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un éditeur politique expert en vérification de contenus civiques.
Tu relis des promesses électorales extraites automatiquement de programmes politiques français.

Ton rôle : détecter les problèmes de qualité qui nécessitent une relecture humaine.
Tu n'exprimes AUCUN jugement politique. Tu évalues uniquement la QUALITÉ FORMELLE.

CRITÈRE 1 — NEUTRALITÉ (ok_neutralite)
false si :
  - Vocabulaire partisan : "dangereuse réforme", "excellente mesure", "enfin", "courageusement"
  - Reformulation qui amplifie ou minimise par rapport à la source
  - Jugement de valeur implicite dans la formulation
true si : formulation sèche, nominale, factuelle

CRITÈRE 2 — CONCORDANCE (ok_concordance)
false si :
  - La citation ne mentionne pas directement ce que dit l'intitulé
  - La promesse est une inférence de la citation, pas une affirmation directe
  - La citation est trop courte ou trop vague pour prouver l'engagement
true si : la citation contient explicitement la promesse

CRITÈRE 3 — CONCRÉTUDE (ok_concretude)
false si :
  - "Renforcer X", "Améliorer Y", "Soutenir Z" sans modalité concrète
  - Déclaration de valeur ou d'intention sans engagement mesurable
  - Objectif sans mécanisme : "Atteindre le plein emploi" (sans comment)
true si : chiffre, loi nommée, structure créée/supprimée, seuil défini

CRITÈRE 4 — TEMPOREL (ok_temporel)
false si : "cet été", "cette année", "prochainement", "rapidement", "d'ici la fin de l'année"
  (expressions relatives dont l'année de référence n'est pas claire)
true si : année absolue, ou pas de référence temporelle du tout

IMPORTANT : Retourne UN objet d'évaluation PAR promesse dans l'input.
L'id retourné doit être EXACTEMENT l'id reçu en input.`;

// ─── Appel Gemini sur un batch de promesses ─────────────────────────────────
async function reviewBatch(promesses: PromesseDB[]): Promise<EvaluationGemini[]> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",   // Tâche simple → modèle économique suffisant
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: REVIEW_SCHEMA as Parameters<typeof genAI.getGenerativeModel>[0]["generationConfig"],
      temperature: 0,
    },
    systemInstruction: SYSTEM_PROMPT,
  });

  // Format d'input : liste numérotée lisible pour Gemini
  const inputText = promesses.map(p => `
---
ID: ${p.id}
INTITULÉ: ${p.intitule_court}
CITATION SOURCE: ${p.source_citation}
`).join("\n");

  const result = await model.generateContent(inputText);
  const text = result.response.text();

  let parsed: GeminiBatchResponse;
  try {
    parsed = JSON.parse(text) as GeminiBatchResponse;
  } catch {
    console.error("  ❌ Parse JSON échoué pour ce batch");
    // En cas d'erreur, on marque toutes les promesses du batch à revoir
    return promesses.map(p => ({
      id: p.id,
      ok_neutralite: false,
      ok_concordance: false,
      ok_concretude: false,
      ok_temporel: false,
      remarque: "Erreur parsing Gemini — à vérifier manuellement",
    }));
  }

  return parsed.evaluations ?? [];
}

// ─── Calcul du statut depuis l'évaluation ───────────────────────────────────
function computeStatut(eval_: EvaluationGemini): "auto" | "review" {
  const nbProblemes = [
    eval_.ok_neutralite,
    eval_.ok_concordance,
    eval_.ok_concretude,
    eval_.ok_temporel,
  ].filter(v => !v).length;

  return nbProblemes === 0 ? "auto" : "review";
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log(" 03-review-promesses.ts — Relecture automatique Gemini ");
  if (DRY_RUN) console.log(" ⚠️  MODE DRY RUN — aucune écriture en base");
  console.log("════════════════════════════════════════════════════════\n");

  // ── Charger les promesses actives non encore reviewées ──
  let query = supabase
    .from("dim_promesse")
    .select("id, intitule_court, source_citation, description_longue, groupe_id")
    // On ne re-traite pas les promesses déjà évaluées (idempotence)
    .is("statut", null);

  if (GROUPE_FILTER) {
    // Filtre par sigle de groupe — on doit d'abord récupérer l'id du groupe
    const { data: groupe } = await supabase
      .from("dim_groupe")
      .select("id")
      .eq("sigle", GROUPE_FILTER)
      .single();

    if (!groupe) {
      console.error(`❌ Groupe "${GROUPE_FILTER}" introuvable dans dim_groupe`);
      process.exit(1);
    }
    query = query.eq("groupe_id", groupe.id);
  }

  const { data: promesses, error } = await query.order("id");

  if (error) throw new Error(`Chargement promesses: ${error.message}`);
  if (!promesses?.length) {
    console.log("✅ Aucune promesse à évaluer (toutes ont déjà un statut).");
    return;
  }

  console.log(`📋 ${promesses.length} promesse(s) à évaluer`);
  console.log(`   Modèle : gemini-2.5-flash-lite | Batch : ${BATCH_SIZE} promesses/appel`);
  const nbBatches = Math.ceil(promesses.length / BATCH_SIZE);
  console.log(`   Nombre d'appels API : ~${nbBatches}\n`);

  // ── Traitement par batches ──
  const allReviewItems: EvaluationGemini[] = [];
  let nbAuto = 0;
  let nbReview = 0;

  for (let i = 0; i < promesses.length; i += BATCH_SIZE) {
    const batch = promesses.slice(i, i + BATCH_SIZE) as PromesseDB[];
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    process.stdout.write(`  Batch ${batchNum}/${nbBatches} (${batch.length} promesses)...`);
    const startTime = Date.now();

    const evaluations = await reviewBatch(batch);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Compte les résultats de ce batch
    let batchAuto = 0, batchReview = 0;
    evaluations.forEach(e => {
      if (computeStatut(e) === "auto") batchAuto++;
      else batchReview++;
    });

    // ── Sauvegarde BDD immédiate pour ce batch ──
    if (!DRY_RUN) {
      const autoIds = evaluations.filter(e => computeStatut(e) === "auto").map(e => e.id);
      const batchReviewItems = evaluations.filter(e => computeStatut(e) === "review");

      allReviewItems.push(...batchReviewItems);

      if (autoIds.length > 0) {
        const { error: eAuto } = await supabase
          .from("dim_promesse")
          .update({ statut: "auto" })
          .in("id", autoIds);
        if (eAuto) console.error("\n  ❌ Erreur update auto:", eAuto.message);
      }

      for (const e of batchReviewItems) {
        const { error: eReview } = await supabase
          .from("dim_promesse")
          .update({
            statut: "review",
            statut_raison: e.remarque,
          })
          .eq("id", e.id);
        if (eReview) console.error(`\n  ❌ Erreur update review [${e.id}]:`, eReview.message);
      }
    } else {
      allReviewItems.push(...evaluations.filter(e => computeStatut(e) === "review"));
    }

    process.stdout.write(` ${elapsed}s → ✅ ${batchAuto} auto, ⚠️  ${batchReview} à relire${DRY_RUN ? '' : ' (sauvegardé)'}\n`);

    nbAuto += batchAuto;
    nbReview += batchReview;

    // Pause entre batches pour respecter les rate limits Gemini Free (augmenté à 4s pour éviter les erreurs 429)
    if (i + BATCH_SIZE < promesses.length) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // ── Affichage des remarques à la fin ──
  if (DRY_RUN) {
    console.log("\n⚠️  DRY RUN : aucune mise à jour effectuée en base.");
  } else {
    console.log("\n✅ Toutes les promesses ont été traitées et sauvegardées.");
  }

  if (allReviewItems.length > 0) {
    console.log(`\n  📝 ${allReviewItems.length} promesses → statut = 'review'`);
    console.log("  Détail des problèmes :");
    allReviewItems.slice(0, 20).forEach(e => {
      const flags = [
        !e.ok_neutralite ? "biais" : "",
        !e.ok_concordance ? "concordance" : "",
        !e.ok_concretude ? "vague" : "",
        !e.ok_temporel ? "temporel" : "",
      ].filter(Boolean).join(", ");
      console.log(`    [${e.id}] ${flags}${e.remarque ? " — " + e.remarque : ""}`);
    });
    if (allReviewItems.length > 20) {
      console.log(`    ... et ${allReviewItems.length - 20} autres (voir Supabase)`);
    }
  }

  // ── Résumé final ──
  const tauxAuto = ((nbAuto / promesses.length) * 100).toFixed(0);
  console.log("\n════════════════════════════════════════════════════════");
  console.log(" ✔️  RÉSUMÉ");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`  Total évalué      : ${promesses.length} promesses`);
  console.log(`  Auto-validées     : ${nbAuto} (${tauxAuto}%) — aucune action requise`);
  console.log(`  À relire          : ${nbReview} promesses\n`);

  if (nbReview > 0) {
    console.log("🔍 Comment relire dans Supabase :");
    console.log("  1. Table Editor → dim_promesse");
    console.log("  2. Filtre : statut = 'review'");
    console.log("  3. Pour chaque promesse :");
    console.log("     → Si OK après relecture : passe statut à 'valide'");
    console.log("     → Si problème : corrige intitule_court ou passe statut à 'retiree'");
    console.log("  4. Quand tu es satisfait : passe statut_publication à 'publie'");
    console.log("\n  ⚡ Astuce : filtre sur statut = 'review' pour ne voir");
    console.log("     QUE les promesses qui nécessitent ton attention.");
  } else {
    console.log("🎉 Toutes les promesses ont été auto-validées !");
    console.log("   Tu peux passer statut_publication = 'publie' en masse.");
  }
}

main().catch(err => {
  console.error("\n💥 Erreur :", err.message ?? err);
  process.exit(1);
});
