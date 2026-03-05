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
 * Paramètres POST body (optionnels) :
 *   { "dry_run": true }   → simule sans écrire en base
 *   { "max_scrutins": 5 } → limite le nombre de scrutins traités (pour les tests)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI, SchemaType } from "https://esm.sh/@google/generative-ai@0.21.0";

// ─── Types ─────────────────────────────────────────────────────────────────

interface Votant {
  acteurRef: string;  // ex: "PA795778" = uid_an dans dim_depute
  mandatRef?: string;
  parDelegation?: string;
}

interface DecompteNominatif {
  pours?: { votant: Votant | Votant[] } | null;
  contres?: { votant: Votant | Votant[] } | null;
  abstentions?: { votant: Votant | Votant[] } | null;
  nonVotants?: { votant: Votant | Votant[] } | null;
}

interface GroupeVote {
  organeRef: string;
  nombreMembresGroupe?: string | number;
  vote: {
    positionMajoritaire?: string;
    decompteVoix?: {
      pour?: number | string;
      contre?: number | string;
      abstentions?: number | string;
      nonVotants?: number | string;
    };
    decompteNominatif?: DecompteNominatif;
  };
}

interface ScrutinAN {
  uid: string;   // ex: "VTANR5L17V0842"
  dateScrutin: string;   // ISO date "YYYY-MM-DD"
  titre?: string;   // Titre du vote
  legislature?: string;
  sort?: {
    code?: string;    // "adopté" | "rejeté"
    libelle?: string;
  };
  syntheseVote?: {
    nombreVotants?: number | string;
    suffragesExprimes?: number | string;
    decompte?: {
      pour?: number | string;
      contre?: number | string;
      abstentions?: number | string;
    };
  };
  // Structure réelle AN : ventilationVotes.organe.groupes.groupe[]
  ventilationVotes?: {
    organe?: {
      organeRef?: string;
      groupes?: {
        groupe: GroupeVote | GroupeVote[];
      };
    };
  };
}

interface ScrutinFile {
  scrutin: ScrutinAN;
}

interface Promesse {
  id: number;
  intitule_court: string;
  source_citation: string;
  groupe_id: number;
  theme_id: number;
}

interface ClassificationResult {
  promesse_id: number;
  polarite_llm: 1 | -1 | null;
  confidence_score: number;
  raisonnement_llm: string;
}

interface GeminiClassifResponse {
  classifications: {
    promesse_id: number;
    polarite: number;  // 1, -1, ou 0 (non lié)
    confidence: number;  // 0.0 à 1.0
    raisonnement: string;
  }[];
}

// ─── Configuration ─────────────────────────────────────────────────────────

const AN_VOTES_ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip";

// Nombre max de jours en arrière pour chercher des scrutins
// Jours en arrière pour la recherche de nouveaux scrutins.
// Mettre 365 pour le premier run afin de récupérer tout l'historique de la législature.
// Remettre à 7 ensuite pour les runs nocturnes quotidiens.
const LOOKBACK_DAYS = parseInt(Deno.env.get("LOOKBACK_DAYS") ?? "7", 10);

// Seuil de confiance en dessous duquel on passe statut = 'review'
const CONFIDENCE_THRESHOLD = 0.7;

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArray<T>(val: T | T[] | null | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function getSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

// ─── Helpers lecture Little-Endian (Deno natif, sans Buffer Node.js) ─────────
// Deno ne connaît pas Buffer — on lit les octets directement dans Uint8Array.

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
          // Stocké sans compression
          data = compressed;
        } else if (method === 8) {
          // DEFLATE
          data = await inflateRaw(compressed);
        } else {
          // Méthode inconnue — ignoré
          i = dataStart + compSize;
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

  const logEntry = {
    statut: "running" as "running" | "success" | "error",
    dry_run: dryRun,
    scrutins_traites: 0,
    scrutins_inseres: 0,
    classifications_inserees: 0,
    cout_llm_usd: 0,
    erreur: null as string | null,
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

    // Récupère les uid_an déjà en base pour la déduplication
    const { data: existingUids } = await supabase
      .from("fact_scrutin")
      .select("uid_an");
    const knownUids = new Set((existingUids ?? []).map((r: { uid_an: string }) => r.uid_an));

    // Parse et filtre les scrutins
    const nouveauxScrutins: ScrutinAN[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(file.text) as ScrutinFile;
        const s = parsed.scrutin;
        if (!s?.uid) continue;
        if (knownUids.has(s.uid)) continue;                  // déjà en base
        if (s.dateScrutin < since) continue;                  // trop ancien
        nouveauxScrutins.push(s);
        if (nouveauxScrutins.length >= maxScrutins) break;
      } catch { /* JSON corrompu, ignoré */ }
    }

    console.log(`[ETL] ${nouveauxScrutins.length} nouveaux scrutins à traiter`);
    logEntry.scrutins_traites = nouveauxScrutins.length;

    if (nouveauxScrutins.length === 0) {
      logEntry.statut = "success";
      if (!dryRun) await supabase.from("etl_run_log").insert(logEntry);
      return new Response(
        JSON.stringify({ status: "ok", message: "Aucun nouveau scrutin", ...logEntry }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ════════════════════════════════════════════════════════
    // ÉTAPE 3 : Charger les promesses actives publiées
    // ════════════════════════════════════════════════════════
    const { data: promesses, error: pErr } = await supabase
      .from("dim_promesse")
      .select("id, intitule_court, source_citation, groupe_id, theme_id")
      .in("statut", ["auto", "valide", "active"]); // seulement les promesses validées

    if (pErr) throw new Error(`Chargement promesses: ${pErr.message}`);
    if (!promesses?.length) {
      throw new Error("Aucune promesse active validée en base — lance d'abord 03-review-promesses.ts");
    }

    console.log(`[ETL] ${promesses.length} promesses actives chargées`);

    // Charger le mapping uid_an → id pour les députés
    const { data: deputes } = await supabase
      .from("dim_depute")
      .select("id, uid_an, groupe_id");
    const deputeByUidAN = new Map(
      (deputes ?? []).map((d: { id: number; uid_an: string; groupe_id: number }) =>
        [d.uid_an, d]
      )
    );

    // ════════════════════════════════════════════════════════
    // ÉTAPE 4 : Créer le Context Cache Gemini
    //
    // Le Context Cache permet d'envoyer les promesses UNE SEULE FOIS
    // et de les réutiliser pour tous les scrutins de la nuit.
    // Économie : ~90% des tokens input pour les appels répétés.
    // ════════════════════════════════════════════════════════
    console.log("[ETL] Création du Context Cache Gemini...");

    // Format compact pour minimiser les tokens
    const promessesContext = promesses.map((p: Promesse) =>
      `[ID:${p.id}] ${p.intitule_court} | Citation: "${p.source_citation.substring(0, 100)}"`
    ).join("\n");

    // Note : le Context Cache de Gemini nécessite l'API REST directe
    // car le SDK JS ne le supporte pas encore pleinement.
    // On utilise un cache TTL de 2h (largement suffisant pour le run nocturne).
    const cacheRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
        },
        body: JSON.stringify({
          model: "models/gemini-2.5-flash-lite",
          displayName: `promesses-eclaircie-${new Date().toISOString().split("T")[0]}`,
          contents: [{
            role: "user",
            parts: [{
              text: `Tu es un expert en droit parlementaire français. 
Voici la liste complète des promesses électorales à évaluer (${promesses.length} promesses) :

${promessesContext}

Pour chaque scrutin que je vais te soumettre, tu devras évaluer le lien entre ce vote et CHACUNE des promesses.`
            }]
          }],
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
      // Le cache a échoué (ex: trop peu de tokens) — on continue sans cache
      const errText = await cacheRes.text();
      console.warn(`[ETL] Context Cache indisponible (${cacheRes.status}): ${errText}`);
      console.warn("[ETL] → Passage en mode sans cache (plus coûteux)");
    }

    // ════════════════════════════════════════════════════════
    // ÉTAPE 5 : Traiter chaque scrutin
    // ════════════════════════════════════════════════════════
    let totalCost = 0;
    let totalClassifs = 0;

    for (const scrutin of nouveauxScrutins) {
      console.log(`[ETL] Scrutin ${scrutin.uid} — ${scrutin.titre?.substring(0, 60)}...`);

      // ── 5a : Insérer dans fact_scrutin ──
      let scrutinDbId: number | null = null;

      if (!dryRun) {
        const { data: scrutinInserted, error: sErr } = await supabase
          .from("fact_scrutin")
          .insert({
            uid_an: scrutin.uid,
            date_scrutin: scrutin.dateScrutin,
            objet: scrutin.titre ?? "Sans objet",
            expose_des_motifs: "", // Rempli par une version V2 si besoin
            llm_traite: false,
            pertinent: false, // Mis à jour après classification
          })
          .select("id")
          .single();

        if (sErr) {
          console.error(`[ETL] Erreur insertion scrutin ${scrutin.uid}: ${sErr.message}`);
          continue;
        }
        scrutinDbId = scrutinInserted.id;
        logEntry.scrutins_inseres++;
      } else {
        scrutinDbId = -1; // ID fictif pour le dry run
      }

      // ── 5b : Insérer les votes individuels ──
      if (!dryRun && scrutinDbId && scrutinDbId > 0) {
        const votesRows: {
          scrutin_id: number;
          depute_id: number;
          groupe_id_au_moment_du_vote: number;
          position_vote: 1 | -1 | 0 | null;
        }[] = [];

        // Structure réelle AN :
        // ventilationVotes.organe.groupes.groupe[] (un par groupe politique)
        // Chaque groupe a vote.decompteNominatif.{pours,contres,abstentions,nonVotants}
        // Chaque votant est { acteurRef: "PA...", mandatRef, parDelegation }
        const groupes = toArray(
          scrutin.ventilationVotes?.organe?.groupes?.groupe
        ) as GroupeVote[];

        // Extrait les acteurRef depuis un decompteNominatif entry
        const extractActeurRefs = (
          entry: { votant: Votant | Votant[] } | null | undefined
        ): string[] => {
          if (!entry || !entry.votant) return [];
          return toArray(entry.votant).map((v) => v.acteurRef).filter(Boolean);
        };

        for (const groupe of groupes) {
          const nomi = groupe.vote?.decompteNominatif;
          if (!nomi) continue;

          const buildVotes = (acteurRefs: string[], pos: 1 | -1 | 0 | null) =>
            acteurRefs.map(acteurRef => {
              const dep = deputeByUidAN.get(acteurRef);
              if (!dep) return null;
              return {
                scrutin_id: scrutinDbId!,
                depute_id: dep.id,
                groupe_id_au_moment_du_vote: dep.groupe_id,
                position_vote: pos,
              };
            }).filter(Boolean) as typeof votesRows;

          votesRows.push(
            ...buildVotes(extractActeurRefs(nomi.pours), 1),
            ...buildVotes(extractActeurRefs(nomi.contres), -1),
            ...buildVotes(extractActeurRefs(nomi.abstentions), 0),
            ...buildVotes(extractActeurRefs(nomi.nonVotants), null),
          );
        }

        if (votesRows.length > 0) {
          // Insertion par batch de 100
          for (let i = 0; i < votesRows.length; i += 100) {
            await supabase
              .from("fact_vote_individuel")
              .insert(votesRows.slice(i, i + 100));
          }
          console.log(`[ETL]   → ${votesRows.length} votes individuels insérés`);
        }
      }

      // ── 5c : Classification Gemini ──
      const scrutinText = `
SCRUTIN : ${scrutin.uid}
DATE : ${scrutin.dateScrutin}
OBJET : ${scrutin.titre}
RÉSULTAT : ${scrutin.syntheseVote?.libelle ?? "inconnu"} (${scrutin.syntheseVote?.nbreSuffragesPour ?? 0} pour, ${scrutin.syntheseVote?.nbreSuffragesContre ?? 0} contre)
`;

      let classifResponse: GeminiClassifResponse | null = null;
      let inputTokens = 0, outputTokens = 0;

      try {
        let apiResponse: Response;

        if (cacheName) {
          // Appel avec Context Cache via REST API
          apiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
              },
              body: JSON.stringify({
                cachedContent: cacheName,
                contents: [{
                  role: "user",
                  parts: [{
                    text: `Analyse ce scrutin et évalue son lien avec CHAQUE promesse de la liste mise en cache.
N'inclus dans ta réponse que les promesses avec polarite != 0 (lien détecté).

${scrutinText}`
                  }]
                }],
                generationConfig: {
                  responseMimeType: "application/json",
                  responseSchema: CLASSIF_SCHEMA,
                  temperature: 0,
                },
              }),
            }
          );
        } else {
          // Fallback sans cache : on envoie les promesses dans chaque requête
          const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite",
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: CLASSIF_SCHEMA as Parameters<typeof genAI.getGenerativeModel>[0]["generationConfig"],
              temperature: 0,
            },
          });
          const result = await model.generateContent(
            `Voici les promesses :\n${promessesContext}\n\nAnalyse ce scrutin :\n${scrutinText}\n\nN'inclus que les promesses avec polarite != 0.`
          );
          const usage = result.response.usageMetadata;
          inputTokens = usage?.promptTokenCount ?? 0;
          outputTokens = usage?.candidatesTokenCount ?? 0;
          classifResponse = JSON.parse(result.response.text()) as GeminiClassifResponse;
          apiResponse = null as unknown as Response; // déjà traité
        }

        if (apiResponse !== null) {
          if (!apiResponse.ok) {
            console.error(`[ETL] Gemini error: ${apiResponse.status}`);
          } else {
            const data = await apiResponse.json() as {
              usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
              candidates?: { content: { parts: { text: string }[] } }[];
            };
            inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
            outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
            classifResponse = JSON.parse(text) as GeminiClassifResponse;
          }
        }

        // Coût Gemini 2.5 Flash-Lite : $0.10/1M input, $0.40/1M output
        const cost = (inputTokens * 0.10 + outputTokens * 0.40) / 1_000_000;
        totalCost += cost;

      } catch (geminiErr) {
        console.error(`[ETL] Gemini erreur scrutin ${scrutin.uid}:`, geminiErr);
      }

      // ── 5d : Insérer les classifications ──
      if (classifResponse?.classifications?.length && scrutinDbId) {
        const liensTrouves = classifResponse.classifications.filter(c => c.polarite !== 0);
        console.log(`[ETL]   → ${liensTrouves.length} liens promesse-scrutin détectés`);

        if (!dryRun && liensTrouves.length > 0) {
          // Hash du prompt pour traçabilité (version simple)
          const promptHash = btoa(`gemini-2.5-flash-lite-v1-${new Date().toISOString().split("T")[0]}`).substring(0, 32);

          const classifRows = liensTrouves.map(c => ({
            scrutin_id: scrutinDbId!,
            promesse_id: c.promesse_id,
            polarite_llm: c.polarite as 1 | -1,
            confidence_score: c.confidence,
            raisonnement_llm: c.raisonnement,
            prompt_hash: promptHash,
            statut: c.confidence >= CONFIDENCE_THRESHOLD ? "auto" : "review",
            statut_publication: "brouillon",
          }));

          const { error: cErr } = await supabase
            .from("llm_classification")
            .insert(classifRows);

          if (cErr) {
            console.error(`[ETL] Erreur insertion classifications: ${cErr.message}`);
          } else {
            totalClassifs += classifRows.length;

            // Marquer le scrutin comme traité
            await supabase
              .from("fact_scrutin")
              .update({
                llm_traite: true,
                pertinent: liensTrouves.length > 0,
              })
              .eq("id", scrutinDbId);
          }
        }
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
    // ÉTAPE 6 : Log final
    // ════════════════════════════════════════════════════════
    logEntry.statut = "success";
    logEntry.classifications_inserees = totalClassifs;
    logEntry.cout_llm_usd = Math.round(totalCost * 10000) / 10000;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ETL] ✅ Terminé en ${elapsed}s — ${logEntry.scrutins_inseres} scrutins, ${totalClassifs} classifications, $${logEntry.cout_llm_usd}`);

    if (!dryRun) {
      await supabase.from("etl_run_log").insert(logEntry);
    }

    return new Response(
      JSON.stringify({ status: "ok", elapsed_s: elapsed, ...logEntry }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ETL] 💥 Erreur fatale:", message);

    logEntry.statut = "error";
    logEntry.erreur = message;

    if (!dryRun) {
      await supabase.from("etl_run_log").insert(logEntry);
    }

    return new Response(
      JSON.stringify({ status: "error", message, ...logEntry }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
