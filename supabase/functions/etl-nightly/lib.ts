/**
 * supabase/functions/etl-nightly/lib.ts
 * -------------------------------------
 * Logique pure de l'ETL : types du JSON Open Data AN, normalisation des champs
 * et construction des lignes à insérer.
 *
 * Ce module ne dépend d'AUCUNE API externe (ni Supabase, ni Gemini, ni Deno).
 * C'est volontaire : il est importable à la fois par la Edge Function (Deno) et
 * par les scripts de vérification locaux (`npx tsx`), ce qui permet de tester la
 * fidélité des données sans déployer ni appeler la base.
 */

// ─── Types du JSON Open Data de l'Assemblée nationale ───────────────────────
// Structure vérifiée sur le corpus complet de la 17e législature (8 434 scrutins).
// ⚠️ `numero` et `legislature` sont sérialisés en CHAÎNES, pas en entiers.

export interface Votant {
  acteurRef: string;  // ex: "PA795778" = uid_an dans dim_depute
  mandatRef?: string;
  parDelegation?: string;
}

export interface DecompteNominatif {
  pours?: { votant: Votant | Votant[] } | null;
  contres?: { votant: Votant | Votant[] } | null;
  abstentions?: { votant: Votant | Votant[] } | null;
  nonVotants?: { votant: Votant | Votant[] } | null;
  nonVotantsVolontaires?: { votant: Votant | Votant[] } | null;
}

export interface GroupeVote {
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

export interface ScrutinAN {
  uid: string;   // ex: "VTANR5L17V0842"
  numero?: string | number;
  legislature?: string | number;
  dateScrutin: string;   // ISO date "YYYY-MM-DD"
  titre?: string;
  typeVote?: {
    codeTypeVote?: string;    // "SPO" | "SPS" | "MOC"
    libelleTypeVote?: string;
    typeMajorite?: string;
  };
  sort?: {
    code?: string;    // "adopté" | "rejeté"
    libelle?: string;
  };
  demandeur?: {
    texte?: string;
    referenceLegislative?: string | null;
  };
  objet?: {
    libelle?: string;
    dossierLegislatif?: { libelle?: string; dossierRef?: string } | null;
    referenceLegislative?: string | null;
  };
  syntheseVote?: {
    nombreVotants?: number | string;
    suffragesExprimes?: number | string;
    nbrSuffragesRequis?: number | string;
    annonce?: string;
    decompte?: {
      nonVotants?: number | string;
      pour?: number | string;
      contre?: number | string;
      abstentions?: number | string;
      nonVotantsVolontaires?: number | string;
    };
  };
  ventilationVotes?: {
    organe?: {
      organeRef?: string;
      groupes?: {
        groupe: GroupeVote | GroupeVote[];
      };
    };
  };
}

export interface ScrutinFile {
  scrutin: ScrutinAN;
}

// ─── Types applicatifs ──────────────────────────────────────────────────────

export interface Promesse {
  id: number;
  intitule_court: string;
  source_citation: string;
  groupe_id: number;
  theme_id: number;
}

export interface DeputeRef {
  id: number;
  uid_an: string;
  groupe_id: number;
}

/** Ligne fact_scrutin — toutes les colonnes NOT NULL du schéma sont couvertes. */
export interface ScrutinRow {
  uid_an: string;
  numero: number;
  legislature: number;
  titre: string;
  objet: string;
  expose_des_motifs: string | null;
  date_scrutin: string;
  sort_adopte: boolean;
  url_an: string;
  llm_traite: boolean;
  pertinent: boolean | null;
}

export interface VoteRow {
  scrutin_id: number;
  depute_id: number;
  groupe_id_au_moment_du_vote: number;
  position_vote: 1 | -1 | 0 | null;
}

export interface ClassificationBrute {
  promesse_id: number;
  polarite: number;
  confidence: number;
  raisonnement: string;
}

export interface GeminiClassifResponse {
  classifications: ClassificationBrute[];
}

/** Ligne llm_classification — noms de colonnes conformes à civic_tech.sql. */
export interface ClassificationRow {
  scrutin_id: number;
  promesse_id: number;
  polarite_llm: 1 | -1;
  confidence_score: number;
  raisonnement_llm: string;
  modele_llm: string;
  prompt_hash: string;
  statut_validation: "auto" | "review";
  statut_publication: "brouillon";
}

// ─── Helpers de normalisation ───────────────────────────────────────────────

/** L'AN renvoie parfois un objet seul là où on attend un tableau. */
export function toArray<T>(val: T | T[] | null | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/** L'AN sérialise ses entiers en chaînes — conversion tolérante. */
export function toNumber(val: string | number | null | undefined, fallback: number): number {
  if (val === null || val === undefined) return fallback;
  const n = typeof val === "number" ? val : parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Détermine si le texte a été adopté (colonne sort_adopte, NOT NULL).
 * Valeurs observées sur la 17e législature : sort.code ∈ { "adopté", "rejeté" }.
 */
export function isAdopte(scrutin: ScrutinAN): boolean {
  const code = (scrutin.sort?.code ?? "").toLowerCase();
  if (code.startsWith("adopt")) return true;
  if (code.startsWith("rejet")) return false;
  // Repli sur l'annonce officielle si le code est absent ou inattendu
  const annonce = (scrutin.sort?.libelle ?? scrutin.syntheseVote?.annonce ?? "").toLowerCase();
  return annonce.includes("adopt") && !annonce.includes("n'a pas");
}

/** SHA-256 hexadécimal (64 caractères) — le schéma attend un char(64) traçable. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Construction des lignes ────────────────────────────────────────────────

/**
 * Construit la ligne fact_scrutin.
 *
 * L'ancienne version omettait numero, titre et sort_adopte — trois colonnes
 * NOT NULL. Chaque insertion échouait, l'erreur était loguée puis ignorée, et
 * l'ETL se terminait en "success" sans avoir rien écrit en base.
 */
export function buildScrutinRow(scrutin: ScrutinAN): ScrutinRow {
  const numero = toNumber(scrutin.numero, 0);
  const legislature = toNumber(scrutin.legislature, 17);
  return {
    uid_an: scrutin.uid,
    numero,
    legislature,
    titre: (scrutin.titre ?? scrutin.objet?.libelle ?? "Sans titre").substring(0, 500),
    objet: scrutin.objet?.libelle ?? scrutin.titre ?? "Sans objet",
    expose_des_motifs: null, // Absent de Scrutins.json — enrichissement prévu au Sprint 2
    date_scrutin: scrutin.dateScrutin,
    sort_adopte: isAdopte(scrutin),
    url_an: `https://www.assemblee-nationale.fr/dyn/${legislature}/scrutins/${numero}`,
    llm_traite: false,
    pertinent: null, // NULL = pas encore filtré (sémantique documentée du schéma)
  };
}

/**
 * Assemble le contexte du scrutin envoyé au LLM, à partir des champs
 * RÉELLEMENT présents dans le JSON AN.
 *
 * L'ancienne version lisait syntheseVote.libelle / nbreSuffragesPour, qui
 * n'existent pas : le modèle recevait toujours "RÉSULTAT : inconnu (0 pour, 0 contre)".
 */
export function buildScrutinText(scrutin: ScrutinAN): string {
  const decompte = scrutin.syntheseVote?.decompte;
  const lignes = [
    `SCRUTIN : ${scrutin.uid} (n°${scrutin.numero ?? "?"})`,
    `DATE : ${scrutin.dateScrutin}`,
    `TYPE : ${scrutin.typeVote?.libelleTypeVote ?? "inconnu"}`,
    `OBJET : ${scrutin.objet?.libelle ?? scrutin.titre ?? "Sans objet"}`,
  ];
  const dossier = scrutin.objet?.dossierLegislatif?.libelle;
  if (dossier) lignes.push(`DOSSIER LÉGISLATIF : ${dossier}`);
  if (scrutin.demandeur?.texte) lignes.push(`DEMANDÉ PAR : ${scrutin.demandeur.texte}`);
  lignes.push(
    `RÉSULTAT : ${scrutin.sort?.libelle ?? scrutin.syntheseVote?.annonce ?? "inconnu"} ` +
    `(${decompte?.pour ?? 0} pour, ${decompte?.contre ?? 0} contre, ${decompte?.abstentions ?? 0} abstentions)`,
  );
  return lignes.join("\n");
}

/**
 * Extrait les votes nominatifs d'un scrutin.
 *
 * ⚠️ Un député absent n'apparaît dans AUCUNE liste : il ne produit donc aucune
 *    ligne. L'absence n'est pas représentable ici — elle se déduit de
 *    `nombreMembresGroupe`. Voir §3.1 de l'audit.
 *
 * ⚠️ groupe_id_au_moment_du_vote reçoit le groupe ACTUEL du député.
 *    Résolution via dim_depute_groupe_historique prévue au Sprint 2.
 */
export function extractVoteRows(
  scrutin: ScrutinAN,
  scrutinDbId: number,
  deputeByUidAN: Map<string, DeputeRef>,
): VoteRow[] {
  const rows: VoteRow[] = [];
  const groupes = toArray(scrutin.ventilationVotes?.organe?.groupes?.groupe);

  const acteurRefs = (entry: { votant: Votant | Votant[] } | null | undefined): string[] => {
    if (!entry || !entry.votant) return [];
    return toArray(entry.votant).map((v) => v.acteurRef).filter(Boolean);
  };

  for (const groupe of groupes) {
    const nomi = groupe.vote?.decompteNominatif;
    if (!nomi) continue;

    const push = (refs: string[], position: 1 | -1 | 0 | null): void => {
      for (const ref of refs) {
        const depute = deputeByUidAN.get(ref);
        if (!depute) continue;
        rows.push({
          scrutin_id: scrutinDbId,
          depute_id: depute.id,
          groupe_id_au_moment_du_vote: depute.groupe_id,
          position_vote: position,
        });
      }
    };

    push(acteurRefs(nomi.pours), 1);
    push(acteurRefs(nomi.contres), -1);
    push(acteurRefs(nomi.abstentions), 0);
    push(acteurRefs(nomi.nonVotants), null);
    push(acteurRefs(nomi.nonVotantsVolontaires), null);
  }
  return rows;
}

// ─── Validation des sorties du LLM ──────────────────────────────────────────

export interface ValidationResult {
  retenus: ClassificationBrute[];
  rejetesPolarite: number;
  rejetesInconnus: number;
  rejetesDoublons: number;
}

/**
 * Filtre les classifications renvoyées par le modèle avant écriture en base.
 *
 * Trois validations indispensables :
 *   1. polarite ∈ {1, -1}            — 0 signifie "pas de lien"
 *   2. promesse_id réellement envoyé  — sinon violation de clé étrangère
 *   3. unicité du promesse_id         — un doublon fait échouer l'upsert du lot entier
 *      ("ON CONFLICT DO UPDATE command cannot affect row a second time")
 */
export function validateClassifications(
  brutes: ClassificationBrute[] | undefined,
  validPromesseIds: ReadonlySet<number>,
): ValidationResult {
  const result: ValidationResult = {
    retenus: [],
    rejetesPolarite: 0,
    rejetesInconnus: 0,
    rejetesDoublons: 0,
  };
  const vus = new Set<number>();

  for (const c of brutes ?? []) {
    if (c.polarite !== 1 && c.polarite !== -1) { result.rejetesPolarite++; continue; }
    if (!validPromesseIds.has(c.promesse_id)) { result.rejetesInconnus++; continue; }
    if (vus.has(c.promesse_id)) { result.rejetesDoublons++; continue; }
    vus.add(c.promesse_id);
    result.retenus.push(c);
  }
  return result;
}

/** Construit les lignes llm_classification à partir des classifications validées. */
export function buildClassificationRows(
  retenus: ClassificationBrute[],
  scrutinDbId: number,
  modeleLlm: string,
  promptHash: string,
  confidenceThreshold: number,
): ClassificationRow[] {
  return retenus.map((c) => {
    const confidence = Math.min(1, Math.max(0, c.confidence ?? 0));
    return {
      scrutin_id: scrutinDbId,
      promesse_id: c.promesse_id,
      polarite_llm: c.polarite as 1 | -1,
      // numeric(3,2) : borner et arrondir pour éviter tout rejet côté Postgres
      confidence_score: Math.round(confidence * 100) / 100,
      raisonnement_llm: c.raisonnement ?? "",
      modele_llm: modeleLlm,          // colonne NOT NULL, était absente
      prompt_hash: promptHash,
      // La colonne s'appelle statut_validation, pas statut
      statut_validation: confidence >= confidenceThreshold ? "auto" : "review",
      statut_publication: "brouillon",
    };
  });
}
