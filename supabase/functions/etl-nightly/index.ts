/**
 * supabase/functions/etl-nightly/index.ts
 * ----------------------------------------
 * Edge Function déclenchée chaque nuit par pg_cron.
 *
 * DEUX PHASES DÉCOUPLÉES, reliées par une file d'attente persistante en base :
 *
 *   PHASE 1 — INGESTION (sans LLM, donc rapide et gratuite)
 *     1. Télécharge le ZIP des scrutins de l'Open Data AN
 *     2. Retient ceux absents de fact_scrutin (déduplication par uid_an)
 *     3. Insère fact_scrutin (avec le drapeau `eligible`) + fact_vote_individuel
 *
 *   PHASE 2 — CLASSIFICATION (appels Gemini)
 *     4. Lit la file `eligible = true AND llm_traite = false`, du plus ancien au plus récent
 *     5. Pré-filtre les promesses candidates par thème, puis appelle Gemini
 *     6. Insère llm_classification en statut_publication = 'brouillon'
 *     7. Marque le scrutin llm_traite = true
 *
 * Pourquoi deux phases : le plafond par run ne fait plus perdre de scrutins.
 * Un scrutin ingéré mais non classifié reste dans la file jusqu'à traitement
 * effectif, quel que soit le nombre de runs nécessaires.
 *
 * La logique pure (types AN, normalisation, éligibilité, pré-filtrage, validation
 * des sorties LLM) vit dans ./lib.ts et se teste hors ligne :
 *   npx tsx scripts/04-verify-etl-mapping.ts
 *
 * Paramètres POST body (optionnels) :
 *   { "dry_run": true }        → simule sans écrire en base
 *   { "max_ingest": 300 }      → scrutins ingérés au maximum sur ce run
 *   { "max_classify": 40 }     → scrutins classifiés au maximum sur ce run
 *   { "phase": "ingest" }      → n'exécuter qu'une phase ("ingest" | "classify")
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI, SchemaType } from "https://esm.sh/@google/generative-ai@0.21.0";

import {
  buildClassificationRows,
  buildScrutinRow,
  buildScrutinTextFromRow,
  extractVoteRows,
  selectCandidatePromesses,
  sha256Hex,
  validateClassifications,
  type DeputeRef,
  type GeminiClassifResponse,
  type GroupeHistoriqueRow,
  type Promesse,
  type ScrutinAN,
  type ScrutinFile,
  type ScrutinQueueRow,
} from "./lib.ts";

/** Forme minimale d'un retour PostgREST, suffisante pour la pagination générique. */
interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

// ─── Configuration ─────────────────────────────────────────────────────────

const AN_VOTES_ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip";

// Fenêtre glissante optionnelle. 0 = aucune limite de date : c'est le réglage
// normal désormais, puisque la file d'attente persistante garantit qu'aucun
// scrutin n'est perdu même si le backlog s'étale sur plusieurs runs.
const LOOKBACK_DAYS = parseInt(Deno.env.get("LOOKBACK_DAYS") ?? "0", 10);

// Seuil de confiance en dessous duquel on passe statut_validation = 'review'.
// ⚠️ La confiance auto-déclarée par un LLM est mal calibrée : ce seuil n'est
//    qu'un filet grossier, remplacé par l'accord inter-modèles au Sprint 4.
const CONFIDENCE_THRESHOLD = 0.7;

// Modèle de classification — tracé dans llm_classification.modele_llm.
// ⚠️ gemini-2.5-flash-lite est arrêté par Google le 16 octobre 2026.
//    Migration prévue (Sprint 8) vers gemini-3.6-flash + gemini-3.5-flash-lite en double passe.
const MODEL_CLASSIFICATION = "gemini-2.5-flash-lite";

// Tarifs $/1M tokens du modèle ci-dessus. À mettre à jour en même temps que le modèle.
const PRICE_INPUT_PER_M = 0.10;
const PRICE_OUTPUT_PER_M = 0.40;

// Nombre maximal de promesses soumises au LLM pour un scrutin, après pré-filtrage
// thématique. Au-delà, le rappel s'effondre et les identifiants hallucinés explosent.
const MAX_CANDIDATES = 40;

// Taille de page PostgREST. Supabase plafonne silencieusement les SELECT à 1000
// lignes (`max_rows` dans supabase/config.toml) : toute lecture non paginée tronque.
const PAGE_SIZE = 1000;

/**
 * Gabarit du prompt système. Le hash tracé dans llm_classification.prompt_hash
 * porte sur CE gabarit (et le modèle), pas sur la liste de promesses qui varie
 * d'un scrutin à l'autre : c'est la version du prompt qu'on veut pouvoir rejouer.
 */
const SYSTEM_PROMPT_TEMPLATE = `Tu es un expert en droit parlementaire français.
On te soumet un scrutin de l'Assemblée nationale et une liste de promesses électorales.

Pour CHAQUE promesse, détermine s'il existe un lien direct avec ce scrutin :
  polarite = 1  → voter POUR ce scrutin va dans le sens de la promesse
  polarite = -1 → voter POUR ce scrutin va à l'encontre de la promesse
  polarite = 0  → aucun lien direct

Règles impératives :
- N'inclus dans ta réponse QUE les promesses avec polarite != 0.
- Le champ promesse_id doit reprendre EXACTEMENT un identifiant fourni en entrée.
- Sois strict : en cas de lien seulement thématique ou indirect, réponds 0.
- Tu n'exprimes aucun jugement politique, tu établis un lien logique.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSince(): string | null {
  if (!Number.isFinite(LOOKBACK_DAYS) || LOOKBACK_DAYS <= 0) return null;
  const d = new Date();
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

/**
 * Lit l'intégralité d'une table en paginant par `range()`.
 * Indispensable : sans cela PostgREST s'arrête à 1000 lignes sans erreur ni avertissement.
 */
async function fetchAllPaginated<T>(
  runPage: (from: number, to: number) => PromiseLike<QueryResult>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// ─── Helpers lecture Little-Endian (Deno natif, sans Buffer Node.js) ─────────

function readUInt32LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}
function readUInt16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

/** Décompresse un stream DEFLATE via l'API DecompressionStream native de Deno */
async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

const decoder = new TextDecoder("utf-8");

/** Parse le ZIP des scrutins — version Deno native, sans Buffer Node.js */
async function parseZip(buf: Uint8Array): Promise<{ name: string; text: string }[]> {
  const files: { name: string; text: string }[] = [];
  let i = 0;

  while (i < buf.length - 4) {
    // Signature Local File Header : PK\x03\x04
    if (readUInt32LE(buf, i) !== 0x04034b50) { i++; continue; }

    const method = readUInt16LE(buf, i + 8);
    const compSize = readUInt32LE(buf, i + 18);
    const nameLen = readUInt16LE(buf, i + 26);
    const extraLen = readUInt16LE(buf, i + 28);
    const name = decoder.decode(buf.slice(i + 30, i + 30 + nameLen));
    const dataStart = i + 30 + nameLen + extraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);

    if (compSize > 0 && !name.endsWith("/") && name.endsWith(".json")) {
      try {
        let data: Uint8Array;
        if (method === 0) {
          data = compressed;              // Stocké sans compression
        } else if (method === 8) {
          data = await inflateRaw(compressed);  // DEFLATE
        } else {
          i = dataStart + compSize;       // Méthode inconnue — ignoré
          continue;
        }
        files.push({ name, text: decoder.decode(data) });
      } catch { /* fichier corrompu, ignoré */ }
    }
    i = dataStart + compSize;
  }
  return files;
}

// ─── Schema Gemini pour la classification ───────────────────────────────────

const CLASSIF_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    classifications: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          promesse_id: {
            type: SchemaType.INTEGER,
            description: "L'ID exact de la promesse fournie en input. NE PAS MODIFIER.",
          },
          polarite: {
            type: SchemaType.INTEGER,
            enum: [1, -1, 0],
            description: "1 = voter POUR ce scrutin va dans le sens de la promesse. -1 = voter POUR va à l'encontre. 0 = pas de lien direct.",
          },
          confidence: {
            type: SchemaType.NUMBER,
            description: "Score de confiance de 0.0 à 1.0. 1.0 = certitude absolue, 0.5 = lien indirect.",
          },
          raisonnement: {
            type: SchemaType.STRING,
            description: "Explication courte (max 150 caractères) du lien ou de l'absence de lien.",
          },
        },
        required: ["promesse_id", "polarite", "confidence", "raisonnement"],
      },
    },
  },
};

// ─── Handler principal ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  // Lecture des paramètres optionnels
  let dryRun = false;
  let maxIngest = 300;
  let maxClassify = 40;
  let phase: "ingest" | "classify" | "both" = "both";
  try {
    const body = await req.json();
    dryRun = body?.dry_run === true;
    maxIngest = body?.max_ingest ?? 300;
    maxClassify = body?.max_classify ?? 40;
    if (body?.phase === "ingest" || body?.phase === "classify") phase = body.phase;
  } catch { /* body vide, valeurs par défaut */ }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const genAI = new GoogleGenerativeAI(Deno.env.get("GEMINI_API_KEY")!);

  const stats = {
    scrutinsDetectes: 0,
    scrutinsInseres: 0,
    scrutinsEligibles: 0,
    votesInseres: 0,
    fileAttenteRestante: 0,
    scrutinsClassifies: 0,
    classificationsInserees: 0,
    scoresRecalcules: 0,
    erreurs: 0,
    coutLlmUsd: 0,
  };
  const messagesErreur: string[] = [];

  const noteErreur = (message: string): void => {
    console.error(`[ETL] ❌ ${message}`);
    stats.erreurs++;
    messagesErreur.push(message);
  };

  /** Écrit dans etl_run_log en respectant EXACTEMENT les colonnes du schéma. */
  const writeLog = async (statut: "success" | "partial" | "error", detail: string | null) => {
    if (dryRun) return;
    const { error } = await supabase.from("etl_run_log").insert({
      run_type: "daily_etl",
      statut,
      nb_scrutins_nouveaux: stats.scrutinsInseres,
      nb_classes: stats.classificationsInserees,
      nb_erreurs: stats.erreurs,
      detail_erreur: detail,
      duree_ms: Date.now() - startTime,
      cout_llm_usd: Math.round(stats.coutLlmUsd * 1_000_000) / 1_000_000,
    });
    if (error) console.error(`[ETL] ⚠️ Échec écriture etl_run_log: ${error.message}`);
  };

  try {
    console.log(
      `[ETL] Démarrage — dry_run=${dryRun}, phase=${phase}, ` +
      `max_ingest=${maxIngest}, max_classify=${maxClassify}`
    );

    // ════════════════════════════════════════════════════════
    // PHASE 1 — INGESTION
    // ════════════════════════════════════════════════════════
    if (phase === "both" || phase === "ingest") {
      console.log("[ETL] ── Phase 1 : ingestion ──");

      const res = await fetch(AN_VOTES_ZIP_URL, {
        headers: { "User-Agent": "LEclaircie-ETL/1.0" },
      });
      if (!res.ok) throw new Error(`Téléchargement scrutins: HTTP ${res.status}`);

      const zipBuffer = new Uint8Array(await res.arrayBuffer());
      const files = await parseZip(zipBuffer);
      console.log(`[ETL] ${files.length} fichiers scrutin extraits du ZIP`);

      // uid_an déjà en base — pagination obligatoire (>1000 scrutins attendus)
      const existingUids = await fetchAllPaginated<{ uid_an: string }>(
        (from, to) => supabase
          .from("fact_scrutin")
          .select("uid_an")
          .order("id", { ascending: true })
          .range(from, to),
        "Lecture fact_scrutin",
      );
      const knownUids = new Set(existingUids.map((r) => r.uid_an));
      console.log(`[ETL] ${knownUids.size} scrutins déjà en base`);

      const since = getSince();
      const candidats: ScrutinAN[] = [];
      for (const file of files) {
        try {
          const s = (JSON.parse(file.text) as ScrutinFile).scrutin;
          if (!s?.uid) continue;
          if (knownUids.has(s.uid)) continue;
          if (since !== null && s.dateScrutin < since) continue;
          candidats.push(s);
        } catch { /* JSON corrompu, ignoré */ }
      }

      // Tri chronologique AVANT plafond : le ZIP est ordonné alphabétiquement
      // (V1, V10, V100…), un découpage brut produirait un échantillon arbitraire.
      candidats.sort((a, b) => a.dateScrutin.localeCompare(b.dateScrutin));
      const aIngerer = candidats.slice(0, maxIngest);
      stats.scrutinsDetectes = candidats.length;

      console.log(
        `[ETL] ${candidats.length} nouveaux scrutins détectés, ${aIngerer.length} ingérés ce run` +
        (candidats.length > aIngerer.length
          ? ` (${candidats.length - aIngerer.length} au prochain run)`
          : "")
      );

      if (aIngerer.length > 0 && !dryRun) {
        // Référentiel des députés + historique des groupes
        const deputes = await fetchAllPaginated<DeputeRef>(
          (from, to) => supabase
            .from("dim_depute")
            .select("id, uid_an, groupe_id")
            .order("id", { ascending: true })
            .range(from, to),
          "Chargement députés",
        );
        const deputeByUidAN = new Map(deputes.map((d) => [d.uid_an, d]));

        const historique = await fetchAllPaginated<GroupeHistoriqueRow>(
          (from, to) => supabase
            .from("dim_depute_groupe_historique")
            .select("depute_id, groupe_id, date_debut, date_fin")
            .order("id", { ascending: true })
            .range(from, to),
          "Chargement historique groupes",
        );
        const historiqueParDepute = new Map<number, GroupeHistoriqueRow[]>();
        for (const h of historique) {
          const liste = historiqueParDepute.get(h.depute_id);
          if (liste) liste.push(h);
          else historiqueParDepute.set(h.depute_id, [h]);
        }
        console.log(
          `[ETL] ${deputeByUidAN.size} députés, ${historique.length} entrées d'historique de groupe`
        );

        for (const scrutin of aIngerer) {
          const row = buildScrutinRow(scrutin);

          const { data: inserted, error: sErr } = await supabase
            .from("fact_scrutin")
            .insert(row)
            .select("id")
            .single();

          if (sErr) {
            noteErreur(`insert fact_scrutin ${scrutin.uid}: ${sErr.message}`);
            continue;
          }
          stats.scrutinsInseres++;
          if (row.eligible) stats.scrutinsEligibles++;

          const votesRows = extractVoteRows(scrutin, inserted.id, deputeByUidAN, historiqueParDepute);
          for (let i = 0; i < votesRows.length; i += 100) {
            const lot = votesRows.slice(i, i + 100);
            const { error: vErr } = await supabase.from("fact_vote_individuel").insert(lot);
            if (vErr) noteErreur(`insert votes ${scrutin.uid}: ${vErr.message}`);
            else stats.votesInseres += lot.length;
          }
        }

        console.log(
          `[ETL] Phase 1 terminée — ${stats.scrutinsInseres} scrutins ` +
          `(dont ${stats.scrutinsEligibles} éligibles), ${stats.votesInseres} votes`
        );
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 2 — CLASSIFICATION depuis la file d'attente
    // ════════════════════════════════════════════════════════
    if (phase === "both" || phase === "classify") {
      console.log("[ETL] ── Phase 2 : classification ──");

      // File d'attente persistante : rien n'est perdu entre deux runs.
      const { data: fileAttente, error: qErr } = await supabase
        .from("fact_scrutin")
        .select(
          "id, uid_an, numero, titre, objet, date_scrutin, sort_adopte, " +
          "type_vote, libelle_type_vote, categorie, dossier_libelle, demandeur"
        )
        .eq("eligible", true)
        .eq("llm_traite", false)
        .order("date_scrutin", { ascending: true })
        .limit(maxClassify);

      if (qErr) throw new Error(`Lecture file d'attente: ${qErr.message}`);

      const { count: restants } = await supabase
        .from("fact_scrutin")
        .select("*", { count: "exact", head: true })
        .eq("eligible", true)
        .eq("llm_traite", false);
      stats.fileAttenteRestante = restants ?? 0;

      const aClassifier = (fileAttente ?? []) as ScrutinQueueRow[];
      console.log(
        `[ETL] ${stats.fileAttenteRestante} scrutins en attente, ${aClassifier.length} traités ce run`
      );

      if (aClassifier.length > 0) {
        // Promesses CANONIQUES uniquement : les programmes communs (NFP, Ensemble)
        // ne sont plus dupliqués par groupe, donc classifiés une seule fois.
        const promesses = await fetchAllPaginated<Promesse>(
          (from, to) => supabase
            .from("dim_promesse")
            .select("id, intitule_court, source_citation, groupe_id, theme_id")
            .eq("est_canonique", true)
            .in("statut", ["auto", "valide", "active"])
            .order("id", { ascending: true })
            .range(from, to),
          "Chargement promesses",
        );

        if (promesses.length === 0) {
          throw new Error(
            "Aucune promesse canonique validée en base — lance d'abord 03-review-promesses.ts"
          );
        }

        const themes = await fetchAllPaginated<{ id: number; slug: string }>(
          (from, to) => supabase
            .from("dim_theme")
            .select("id, slug")
            .order("id", { ascending: true })
            .range(from, to),
          "Chargement thèmes",
        );
        const themeSlugById = new Map(themes.map((t) => [t.id, t.slug]));

        console.log(
          `[ETL] ${promesses.length} promesses canoniques, ${themeSlugById.size} thèmes chargés`
        );

        const promptHash = await sha256Hex(`${MODEL_CLASSIFICATION}||${SYSTEM_PROMPT_TEMPLATE}`);

        const model = genAI.getGenerativeModel({
          model: MODEL_CLASSIFICATION,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: CLASSIF_SCHEMA as Parameters<
              typeof genAI.getGenerativeModel
            >[0]["generationConfig"],
            temperature: 0,
          },
          systemInstruction: SYSTEM_PROMPT_TEMPLATE,
        });

        let repliCount = 0;

        for (const scrutinRow of aClassifier) {
          const scrutinText = buildScrutinTextFromRow(scrutinRow);

          // Pré-filtrage thématique : ~1000 promesses → quelques dizaines.
          const prefiltre = selectCandidatePromesses(
            scrutinText, promesses, themeSlugById, MAX_CANDIDATES,
          );
          if (prefiltre.repliToutesPromesses) repliCount++;

          const listePromesses = prefiltre.candidates
            .map((p) => `[ID:${p.id}] ${p.intitule_court} | Citation: "${p.source_citation.substring(0, 150)}"`)
            .join("\n");

          const validPromesseIds = new Set(prefiltre.candidates.map((p) => p.id));

          let reponse: GeminiClassifResponse | null = null;
          try {
            const result = await model.generateContent(
              `PROMESSES À ÉVALUER (${prefiltre.candidates.length}) :\n${listePromesses}\n\n` +
              `SCRUTIN :\n${scrutinText}`
            );
            const usage = result.response.usageMetadata;
            stats.coutLlmUsd +=
              ((usage?.promptTokenCount ?? 0) * PRICE_INPUT_PER_M +
                (usage?.candidatesTokenCount ?? 0) * PRICE_OUTPUT_PER_M) / 1_000_000;
            reponse = JSON.parse(result.response.text()) as GeminiClassifResponse;
          } catch (geminiErr) {
            const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
            noteErreur(`gemini ${scrutinRow.uid_an}: ${msg}`);
          }

          // Appel raté : llm_traite reste false, le scrutin est rejoué au prochain run.
          if (!reponse) continue;

          const validation = validateClassifications(reponse.classifications, validPromesseIds);
          if (validation.rejetesInconnus > 0) {
            console.warn(
              `[ETL]   ⚠️ ${scrutinRow.uid_an}: ${validation.rejetesInconnus} promesse_id inconnus rejetés`
            );
          }
          if (validation.rejetesDoublons > 0) {
            console.warn(
              `[ETL]   ⚠️ ${scrutinRow.uid_an}: ${validation.rejetesDoublons} doublons rejetés`
            );
          }
          console.log(
            `[ETL]   ${scrutinRow.uid_an} [${prefiltre.themesDetectes.slice(0, 3).join(",") || "aucun thème"}] ` +
            `${prefiltre.candidates.length} candidates → ${validation.retenus.length} liens`
          );

          if (dryRun) continue;

          if (validation.retenus.length > 0) {
            const classifRows = buildClassificationRows(
              validation.retenus, scrutinRow.id, MODEL_CLASSIFICATION, promptHash, CONFIDENCE_THRESHOLD,
            );

            const { error: cErr } = await supabase
              .from("llm_classification")
              .upsert(classifRows, { onConflict: "scrutin_id,promesse_id" });

            if (!cErr) {
              stats.classificationsInserees += classifRows.length;
            } else {
              // Repli ligne par ligne : isoler la ligne fautive plutôt que de
              // perdre toutes les classifications du scrutin.
              console.warn(`[ETL]   ⚠️ Upsert groupé échoué (${cErr.message}) — repli ligne par ligne`);
              for (const row of classifRows) {
                const { error: rowErr } = await supabase
                  .from("llm_classification")
                  .upsert(row, { onConflict: "scrutin_id,promesse_id" });
                if (rowErr) noteErreur(`classif ${scrutinRow.uid_an}/${row.promesse_id}: ${rowErr.message}`);
                else stats.classificationsInserees++;
              }
            }
          }

          // Marquer traité même sans lien trouvé, sinon le scrutin resterait
          // indéfiniment dans la file d'attente.
          const { error: uErr } = await supabase
            .from("fact_scrutin")
            .update({ llm_traite: true, pertinent: validation.retenus.length > 0 })
            .eq("id", scrutinRow.id);
          if (uErr) noteErreur(`update llm_traite ${scrutinRow.uid_an}: ${uErr.message}`);
          else stats.scrutinsClassifies++;
        }

        if (repliCount > 0) {
          console.warn(
            `[ETL] ⚠️ ${repliCount}/${aClassifier.length} scrutins sans thème détecté ` +
            `→ toutes les promesses envoyées. Enrichir THEME_KEYWORDS dans lib.ts.`
          );
        }
        stats.fileAttenteRestante = Math.max(0, stats.fileAttenteRestante - stats.scrutinsClassifies);
      }
    }

    // ════════════════════════════════════════════════════════
    // PHASE 3 — Recalcul des scores
    //
    // Le calcul vit en SQL (fonction refresh_scores) : n'importe qui ayant accès
    // au schéma peut le relire et refaire le calcul. Argument de neutralité
    // autant que choix technique — voir §4.5 de l'audit.
    // ════════════════════════════════════════════════════════
    if (!dryRun && (stats.classificationsInserees > 0 || phase === "classify")) {
      console.log("[ETL] ── Phase 3 : recalcul des scores ──");
      const { data: bilan, error: rErr } = await supabase.rpc("refresh_scores");
      if (rErr) {
        noteErreur(`refresh_scores: ${rErr.message}`);
      } else {
        const lignes = (bilan ?? []) as { niveau: string; lignes: number; publiables: number }[];
        for (const l of lignes) {
          console.log(`[ETL]   ${l.niveau} : ${l.lignes} scores, dont ${l.publiables} publiables`);
        }
        stats.scoresRecalcules = lignes.reduce((acc, l) => acc + Number(l.lignes), 0);
      }
    }

    // ════════════════════════════════════════════════════════
    // Bilan — échouer bruyamment plutôt que silencieusement
    // ════════════════════════════════════════════════════════
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    stats.coutLlmUsd = Math.round(stats.coutLlmUsd * 1_000_000) / 1_000_000;

    // Des scrutins étaient à ingérer mais aucun n'a été inséré : mode de
    // défaillance qui avait rendu l'ETL muet pendant des semaines.
    const ingestionMuette =
      !dryRun && (phase === "both" || phase === "ingest") &&
      stats.scrutinsDetectes > 0 && stats.scrutinsInseres === 0;

    if (ingestionMuette) {
      const detail =
        `Aucun scrutin inséré alors que ${stats.scrutinsDetectes} étaient détectés. ` +
        `Premières erreurs: ${messagesErreur.slice(0, 3).join(" | ") || "aucune remontée"}`;
      console.error(`[ETL] 💥 ${detail}`);
      await writeLog("error", detail);
      return new Response(
        JSON.stringify({ status: "error", message: detail, elapsed_s: elapsed, ...stats }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const statut = stats.erreurs > 0 ? "partial" : "success";
    const detail = stats.erreurs > 0 ? messagesErreur.slice(0, 10).join(" | ") : null;

    console.log(
      `[ETL] ${statut === "success" ? "✅" : "⚠️"} Terminé en ${elapsed}s — ` +
      `${stats.scrutinsInseres} scrutins ingérés, ${stats.scrutinsClassifies} classifiés, ` +
      `${stats.classificationsInserees} liens, ${stats.fileAttenteRestante} en attente, ` +
      `${stats.erreurs} erreurs, $${stats.coutLlmUsd}`
    );

    await writeLog(statut, detail);

    return new Response(
      JSON.stringify({ status: statut, elapsed_s: elapsed, ...stats }),
      {
        status: statut === "partial" ? 207 : 200,
        headers: { "Content-Type": "application/json" },
      }
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ETL] 💥 Erreur fatale:", message);

    stats.erreurs++;
    await writeLog("error", message);

    return new Response(
      JSON.stringify({ status: "error", message, ...stats }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
