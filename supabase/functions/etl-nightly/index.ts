/**
 * supabase/functions/etl-nightly/index.ts
 * ----------------------------------------
 * Edge Function déclenchée chaque nuit par pg_cron.
 *
 * Workflow :
 *   1. Télécharge les scrutins récents depuis l'Open Data AN
 *   2. Filtre ceux absents de fact_scrutin (déduplication par uid_an)
 *   3. Insère fact_scrutin + fact_vote_individuel
 *   4. Pour chaque scrutin pertinent : classifie avec Gemini via Context Cache
 *   5. Insère llm_classification avec statut_publication = 'brouillon'
 *   6. Log dans etl_run_log
 *
 * La logique pure (types AN, normalisation, construction des lignes, validation
 * des sorties LLM) vit dans ./lib.ts pour être testable hors ligne — voir
 * `npx tsx scripts/04-verify-etl-mapping.ts`.
 *
 * Paramètres POST body (optionnels) :
 *   { "dry_run": true }   → simule sans écrire en base
 *   { "max_scrutins": 5 } → limite le nombre de scrutins traités (pour les tests)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI, SchemaType } from "https://esm.sh/@google/generative-ai@0.21.0";

import {
  buildClassificationRows,
  buildScrutinRow,
  buildScrutinText,
  extractVoteRows,
  sha256Hex,
  validateClassifications,
  type DeputeRef,
  type GeminiClassifResponse,
  type Promesse,
  type ScrutinAN,
  type ScrutinFile,
} from "./lib.ts";

/** Forme minimale d'un retour PostgREST, suffisante pour la pagination générique. */
interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

// ─── Configuration ─────────────────────────────────────────────────────────

const AN_VOTES_ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip";

// Jours en arrière pour la recherche de nouveaux scrutins.
// Mettre 365 pour le premier run afin de récupérer tout l'historique de la législature.
// Remettre à 7 ensuite pour les runs nocturnes quotidiens.
const LOOKBACK_DAYS = parseInt(Deno.env.get("LOOKBACK_DAYS") ?? "7", 10);

// Seuil de confiance en dessous duquel on passe statut_validation = 'review'.
// ⚠️ La confiance auto-déclarée par un LLM est mal calibrée : ce seuil n'est
//    qu'un filet grossier, remplacé par l'accord inter-modèles au Sprint 4.
const CONFIDENCE_THRESHOLD = 0.7;

// Modèle de classification — centralisé pour être tracé dans llm_classification.modele_llm.
// ⚠️ gemini-2.5-flash-lite est arrêté par Google le 16 octobre 2026.
//    Migration prévue (Sprint 8) vers gemini-3.6-flash + gemini-3.5-flash-lite en double passe.
const MODEL_CLASSIFICATION = "gemini-2.5-flash-lite";

// Tarifs $/1M tokens du modèle ci-dessus. À mettre à jour en même temps que le modèle.
const PRICE_INPUT_PER_M = 0.10;
const PRICE_OUTPUT_PER_M = 0.40;

// Taille de page PostgREST. Supabase plafonne silencieusement les SELECT à 1000 lignes :
// toute lecture non paginée tronque les données sans lever d'erreur.
const PAGE_SIZE = 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSince(): string {
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
  required: ["classifications"],
};

// ─── Handler principal ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  // Lecture des paramètres optionnels
  let dryRun = false;
  let maxScrutins = 50;
  try {
    const body = await req.json();
    dryRun = body?.dry_run === true;
    maxScrutins = body?.max_scrutins ?? 50;
  } catch { /* body vide, valeurs par défaut */ }

  // ── Init clients ──
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const genAI = new GoogleGenerativeAI(Deno.env.get("GEMINI_API_KEY")!);

  // Compteurs internes du run. Le mapping vers les colonnes réelles de
  // etl_run_log est fait au moment de l'insertion (writeLog).
  const stats = {
    scrutinsTraites: 0,
    scrutinsInseres: 0,
    classificationsInserees: 0,
    erreurs: 0,
    coutLlmUsd: 0,
  };
  const messagesErreur: string[] = [];

  /** Écrit dans etl_run_log en respectant EXACTEMENT les colonnes du schéma. */
  const writeLog = async (statut: "success" | "partial" | "error", detail: string | null) => {
    if (dryRun) return;
    const { error } = await supabase.from("etl_run_log").insert({
      run_type: "daily_etl",
      statut,
      nb_scrutins_nouveaux: stats.scrutinsTraites,
      nb_classes: stats.classificationsInserees,
      nb_erreurs: stats.erreurs,
      detail_erreur: detail,
      duree_ms: Date.now() - startTime,
      cout_llm_usd: Math.round(stats.coutLlmUsd * 1_000_000) / 1_000_000,
    });
    // Si même le log échoue, on veut le voir dans les logs de la Edge Function.
    if (error) console.error(`[ETL] ⚠️ Échec écriture etl_run_log: ${error.message}`);
  };

  try {
    console.log(`[ETL] Démarrage — dry_run=${dryRun}, max=${maxScrutins}`);

    // ════════════════════════════════════════════════════════
    // ÉTAPE 1 : Télécharger les scrutins depuis l'AN
    // ════════════════════════════════════════════════════════
    console.log("[ETL] Téléchargement des scrutins AN...");

    const res = await fetch(AN_VOTES_ZIP_URL, {
      headers: { "User-Agent": "LEclaircie-ETL/1.0" },
    });
    if (!res.ok) throw new Error(`Téléchargement scrutins: HTTP ${res.status}`);

    const zipBuffer = new Uint8Array(await res.arrayBuffer());
    const files = await parseZip(zipBuffer);
    console.log(`[ETL] ${files.length} fichiers scrutin extraits du ZIP`);

    // ════════════════════════════════════════════════════════
    // ÉTAPE 2 : Filtrer les scrutins récents et non traités
    // ════════════════════════════════════════════════════════
    const since = getSince();

    // Récupère les uid_an déjà en base pour la déduplication.
    // Pagination obligatoire : au-delà de 1000 scrutins, une lecture simple
    // renverrait une liste tronquée et on tenterait de réinsérer des doublons.
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

    // Parse et filtre les scrutins
    const candidats: ScrutinAN[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(file.text) as ScrutinFile;
        const s = parsed.scrutin;
        if (!s?.uid) continue;
        if (knownUids.has(s.uid)) continue;                   // déjà en base
        if (s.dateScrutin < since) continue;                  // trop ancien
        candidats.push(s);
      } catch { /* JSON corrompu, ignoré */ }
    }

    // Tri chronologique AVANT d'appliquer le plafond.
    // Les fichiers du ZIP sont ordonnés alphabétiquement (V1, V10, V100, V1000…) :
    // sans ce tri, max_scrutins découpait un sous-ensemble arbitraire du corpus.
    candidats.sort((a, b) => a.dateScrutin.localeCompare(b.dateScrutin));
    const nouveauxScrutins = candidats.slice(0, maxScrutins);

    console.log(
      `[ETL] ${candidats.length} nouveaux scrutins détectés, ${nouveauxScrutins.length} traités ce run`,
    );
    if (candidats.length > nouveauxScrutins.length) {
      console.warn(
        `[ETL] ⚠️ ${candidats.length - nouveauxScrutins.length} scrutins reportés au prochain run ` +
        `(plafond max_scrutins=${maxScrutins}). Ils ne seront repris que tant qu'ils restent dans ` +
        `la fenêtre LOOKBACK_DAYS=${LOOKBACK_DAYS} — file d'attente persistante prévue au Sprint 2.`,
      );
    }
    stats.scrutinsTraites = nouveauxScrutins.length;

    if (nouveauxScrutins.length === 0) {
      console.log("[ETL] ✅ Aucun nouveau scrutin");
      await writeLog("success", null);
      return new Response(
        JSON.stringify({ status: "ok", message: "Aucun nouveau scrutin", ...stats }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ════════════════════════════════════════════════════════
    // ÉTAPE 3 : Charger les promesses actives publiées
    // ════════════════════════════════════════════════════════
    const promesses = await fetchAllPaginated<Promesse>(
      (from, to) => supabase
        .from("dim_promesse")
        .select("id, intitule_court, source_citation, groupe_id, theme_id")
        .in("statut", ["auto", "valide", "active"])   // seulement les promesses validées
        .order("id", { ascending: true })
        .range(from, to),
      "Chargement promesses",
    );

    if (promesses.length === 0) {
      throw new Error("Aucune promesse active validée en base — lance d'abord 03-review-promesses.ts");
    }
    console.log(`[ETL] ${promesses.length} promesses actives chargées`);

    // Ensemble des IDs réellement envoyés au modèle : sert à rejeter les
    // promesse_id hallucinés avant l'INSERT (sinon violation de clé étrangère).
    const validPromesseIds = new Set(promesses.map((p) => p.id));

    // Charger le mapping uid_an → id pour les députés
    const deputes = await fetchAllPaginated<DeputeRef>(
      (from, to) => supabase
        .from("dim_depute")
        .select("id, uid_an, groupe_id")
        .order("id", { ascending: true })
        .range(from, to),
      "Chargement députés",
    );
    const deputeByUidAN = new Map(deputes.map((d) => [d.uid_an, d]));
    console.log(`[ETL] ${deputeByUidAN.size} députés chargés`);

    // ════════════════════════════════════════════════════════
    // ÉTAPE 4 : Créer le Context Cache Gemini
    //
    // Le Context Cache permet d'envoyer les promesses UNE SEULE FOIS
    // et de les réutiliser pour tous les scrutins de la nuit.
    // ════════════════════════════════════════════════════════
    console.log("[ETL] Création du Context Cache Gemini...");

    const promessesContext = promesses.map((p) =>
      `[ID:${p.id}] ${p.intitule_court} | Citation: "${p.source_citation.substring(0, 100)}"`
    ).join("\n");

    const systemPrompt = `Tu es un expert en droit parlementaire français.
Voici la liste complète des promesses électorales à évaluer (${promesses.length} promesses) :

${promessesContext}

Pour chaque scrutin que je vais te soumettre, tu devras évaluer le lien entre ce vote et CHACUNE des promesses.`;

    // Hash SHA-256 réel du couple (modèle, prompt système) : permet de rejouer
    // uniquement les classifications produites par une version donnée du prompt.
    const promptHash = await sha256Hex(`${MODEL_CLASSIFICATION}||${systemPrompt}`);

    const cacheRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
        },
        body: JSON.stringify({
          model: `models/${MODEL_CLASSIFICATION}`,
          displayName: `promesses-eclaircie-${new Date().toISOString().split("T")[0]}`,
          contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
          ttl: "7200s", // 2 heures
        }),
      }
    );

    let cacheName: string | null = null;
    if (cacheRes.ok) {
      const cacheData = await cacheRes.json() as { name: string };
      cacheName = cacheData.name;
      console.log(`[ETL] Context Cache créé : ${cacheName}`);
    } else {
      const errText = await cacheRes.text();
      console.warn(`[ETL] Context Cache indisponible (${cacheRes.status}): ${errText}`);
      console.warn("[ETL] → Passage en mode sans cache (plus coûteux)");
    }

    /**
     * Appelle Gemini pour un scrutin, avec ou sans Context Cache.
     * Renvoie null si l'appel échoue — le scrutin reste alors llm_traite = false
     * pour être rejoué au prochain run.
     */
    const classifyScrutin = async (scrutinText: string): Promise<{
      response: GeminiClassifResponse;
      inputTokens: number;
      outputTokens: number;
    } | null> => {
      const consigne =
        `Analyse ce scrutin et évalue son lien avec CHAQUE promesse de la liste.\n` +
        `N'inclus dans ta réponse que les promesses avec polarite != 0 (lien détecté).\n\n${scrutinText}`;

      if (cacheName) {
        const apiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_CLASSIFICATION}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
            },
            body: JSON.stringify({
              cachedContent: cacheName,
              contents: [{ role: "user", parts: [{ text: consigne }] }],
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: CLASSIF_SCHEMA,
                temperature: 0,
              },
            }),
          }
        );

        if (!apiResponse.ok) {
          console.error(`[ETL] Gemini error ${apiResponse.status}: ${await apiResponse.text()}`);
          return null;
        }
        const data = await apiResponse.json() as {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          candidates?: { content: { parts: { text: string }[] } }[];
        };
        return {
          response: JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}") as GeminiClassifResponse,
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        };
      }

      // Fallback sans cache : les promesses sont envoyées à chaque requête
      const model = genAI.getGenerativeModel({
        model: MODEL_CLASSIFICATION,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: CLASSIF_SCHEMA as Parameters<typeof genAI.getGenerativeModel>[0]["generationConfig"],
          temperature: 0,
        },
        systemInstruction: systemPrompt,
      });
      const result = await model.generateContent(consigne);
      const usage = result.response.usageMetadata;
      return {
        response: JSON.parse(result.response.text()) as GeminiClassifResponse,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    };

    // ════════════════════════════════════════════════════════
    // ÉTAPE 5 : Traiter chaque scrutin
    // ════════════════════════════════════════════════════════
    for (const scrutin of nouveauxScrutins) {
      const libelle = (scrutin.objet?.libelle ?? scrutin.titre ?? "").substring(0, 60);
      console.log(`[ETL] Scrutin ${scrutin.uid} — ${libelle}...`);

      // ── 5a : Insérer dans fact_scrutin ──
      let scrutinDbId = -1; // -1 = ID fictif pour le dry run

      if (!dryRun) {
        const { data: scrutinInserted, error: sErr } = await supabase
          .from("fact_scrutin")
          .insert(buildScrutinRow(scrutin))
          .select("id")
          .single();

        if (sErr) {
          console.error(`[ETL] ❌ Erreur insertion scrutin ${scrutin.uid}: ${sErr.message}`);
          stats.erreurs++;
          messagesErreur.push(`insert fact_scrutin ${scrutin.uid}: ${sErr.message}`);
          continue;
        }
        scrutinDbId = scrutinInserted.id;
        stats.scrutinsInseres++;
      }

      // ── 5b : Insérer les votes individuels ──
      if (!dryRun && scrutinDbId > 0) {
        const votesRows = extractVoteRows(scrutin, scrutinDbId, deputeByUidAN);

        if (votesRows.length > 0) {
          // Insertion par batch de 100 — les erreurs étaient jusqu'ici ignorées.
          let votesInseres = 0;
          for (let i = 0; i < votesRows.length; i += 100) {
            const lot = votesRows.slice(i, i + 100);
            const { error: vErr } = await supabase
              .from("fact_vote_individuel")
              .insert(lot);
            if (vErr) {
              console.error(`[ETL] ❌ Erreur insertion votes ${scrutin.uid}: ${vErr.message}`);
              stats.erreurs++;
              messagesErreur.push(`insert votes ${scrutin.uid}: ${vErr.message}`);
            } else {
              votesInseres += lot.length;
            }
          }
          console.log(`[ETL]   → ${votesInseres}/${votesRows.length} votes individuels insérés`);
        }
      }

      // ── 5c : Classification Gemini ──
      let classifResult: Awaited<ReturnType<typeof classifyScrutin>> = null;
      try {
        classifResult = await classifyScrutin(buildScrutinText(scrutin));
      } catch (geminiErr) {
        const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
        console.error(`[ETL] ❌ Gemini erreur scrutin ${scrutin.uid}: ${msg}`);
        stats.erreurs++;
        messagesErreur.push(`gemini ${scrutin.uid}: ${msg}`);
      }

      // Appel raté : on laisse llm_traite = false pour que le scrutin soit rejouable.
      if (!classifResult) continue;

      stats.coutLlmUsd +=
        (classifResult.inputTokens * PRICE_INPUT_PER_M +
          classifResult.outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

      // ── 5d : Valider puis insérer les classifications ──
      const validation = validateClassifications(
        classifResult.response.classifications,
        validPromesseIds,
      );

      if (validation.rejetesInconnus > 0) {
        console.warn(`[ETL]   ⚠️ ${validation.rejetesInconnus} promesse_id inconnus rejetés (hallucination LLM)`);
      }
      if (validation.rejetesDoublons > 0) {
        console.warn(`[ETL]   ⚠️ ${validation.rejetesDoublons} promesse_id en doublon rejetés`);
      }
      console.log(`[ETL]   → ${validation.retenus.length} liens promesse-scrutin retenus`);

      if (dryRun || scrutinDbId <= 0) continue;

      if (validation.retenus.length > 0) {
        const classifRows = buildClassificationRows(
          validation.retenus,
          scrutinDbId,
          MODEL_CLASSIFICATION,
          promptHash,
          CONFIDENCE_THRESHOLD,
        );

        // Upsert groupé, puis repli ligne par ligne pour isoler une éventuelle
        // ligne fautive au lieu de perdre toutes les classifications du scrutin.
        const { error: cErr } = await supabase
          .from("llm_classification")
          .upsert(classifRows, { onConflict: "scrutin_id,promesse_id" });

        if (!cErr) {
          stats.classificationsInserees += classifRows.length;
        } else {
          console.warn(`[ETL]   ⚠️ Upsert groupé échoué (${cErr.message}) — repli ligne par ligne`);
          for (const row of classifRows) {
            const { error: rowErr } = await supabase
              .from("llm_classification")
              .upsert(row, { onConflict: "scrutin_id,promesse_id" });
            if (rowErr) {
              console.error(`[ETL]   ❌ promesse ${row.promesse_id}: ${rowErr.message}`);
              stats.erreurs++;
              messagesErreur.push(`classif ${scrutin.uid}/${row.promesse_id}: ${rowErr.message}`);
            } else {
              stats.classificationsInserees++;
            }
          }
        }
      }

      // Le scrutin a été soumis au LLM avec succès : on le marque traité même
      // si aucun lien n'a été trouvé, sinon il serait rejoué indéfiniment.
      const { error: uErr } = await supabase
        .from("fact_scrutin")
        .update({ llm_traite: true, pertinent: validation.retenus.length > 0 })
        .eq("id", scrutinDbId);
      if (uErr) {
        console.error(`[ETL] ❌ Erreur update llm_traite ${scrutin.uid}: ${uErr.message}`);
        stats.erreurs++;
        messagesErreur.push(`update fact_scrutin ${scrutin.uid}: ${uErr.message}`);
      }
    }

    // ── Nettoyage du cache Gemini ──
    if (cacheName) {
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${cacheName}`,
        {
          method: "DELETE",
          headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
        }
      );
    }

    // ════════════════════════════════════════════════════════
    // ÉTAPE 6 : Bilan — échouer bruyamment plutôt que silencieusement
    // ════════════════════════════════════════════════════════
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    stats.coutLlmUsd = Math.round(stats.coutLlmUsd * 1_000_000) / 1_000_000;

    // Cas critique : des scrutins étaient à traiter mais AUCUN n'a été inséré.
    // C'est exactement le mode de défaillance qui a rendu l'ETL muet jusqu'ici.
    if (!dryRun && stats.scrutinsTraites > 0 && stats.scrutinsInseres === 0) {
      const detail =
        `Aucun scrutin inséré alors que ${stats.scrutinsTraites} étaient à traiter. ` +
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
      `${stats.scrutinsInseres} scrutins, ${stats.classificationsInserees} classifications, ` +
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
