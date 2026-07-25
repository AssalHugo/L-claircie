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
  /**
   * Rectifications de vote déclarées après le scrutin.
   * Chaque catégorie est une LISTE dont les éléments sont soit `null`
   * (artefact de la conversion XML→JSON), soit `{ votant: … }`.
   * Mesuré : 1 902 scrutins de la 17e législature en comportent au moins une.
   */
  miseAuPoint?: {
    pours?: MiseAuPointEntry[] | MiseAuPointEntry | null;
    contres?: MiseAuPointEntry[] | MiseAuPointEntry | null;
    abstentions?: MiseAuPointEntry[] | MiseAuPointEntry | null;
    nonVotants?: MiseAuPointEntry[] | MiseAuPointEntry | null;
    nonVotantsVolontaires?: MiseAuPointEntry[] | MiseAuPointEntry | null;
  } | null;
}

export interface MiseAuPointEntry {
  votant?: Votant | Votant[] | null;
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

/** Une ligne de dim_depute_groupe_historique. `date_fin = null` ⇒ groupe actuel. */
export interface GroupeHistoriqueRow {
  depute_id: number;
  groupe_id: number;
  date_debut: string;
  date_fin: string | null;
}

/** Catégorie éditoriale d'un scrutin, dérivée du type de vote et du titre. */
export type CategorieScrutin =
  | "solennel"
  | "motion_censure"
  | "ensemble_texte"
  | "motion_procedure"
  | "amendement"
  | "autre";

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
  // ── Sprint 2 : sélection du corpus ──
  type_vote: string | null;
  libelle_type_vote: string | null;
  categorie: CategorieScrutin;
  dossier_ref: string | null;
  dossier_libelle: string | null;
  demandeur: string | null;
  eligible: boolean;
}

export interface VoteRow {
  scrutin_id: number;
  depute_id: number;
  groupe_id_au_moment_du_vote: number;
  position_vote: 1 | -1 | 0 | null;
  par_delegation: boolean;
  position_vote_corrigee: 1 | -1 | 0 | null;
}

/**
 * Scrutin relu depuis la base pour la phase de classification.
 * La phase 2 de l'ETL ne dépend plus du ZIP : tout le contexte nécessaire
 * au LLM est persisté par la phase 1.
 */
export interface ScrutinQueueRow {
  id: number;
  uid_an: string;
  numero: number;
  titre: string;
  objet: string;
  date_scrutin: string;
  sort_adopte: boolean;
  type_vote: string | null;
  libelle_type_vote: string | null;
  categorie: string | null;
  dossier_libelle: string | null;
  demandeur: string | null;
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

/**
 * Normalise un libellé AN pour le rendre comparable.
 *
 * ⚠️ 541 titres de la 17e législature utilisent l'apostrophe typographique U+2019
 *    au lieu de l'apostrophe ASCII. Sans cette normalisation, 10 votes sur
 *    « l'ensemble » d'un texte échappaient au filtre d'éligibilité.
 */
export function normalizeText(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x2018 || cp === 0x2019 || cp === 0x02bc) {
      out += "'";              // apostrophes typographiques → apostrophe ASCII
    } else if (cp === 0x00a0 || cp === 0x202f) {
      out += " ";              // espaces insécables → espace simple
    } else {
      out += ch;
    }
  }
  return out.toLowerCase();
}

/**
 * Supprime les accents — utilisé par la détection thématique.
 * Filtre les diacritiques combinants (U+0300–U+036F) après décomposition NFD,
 * sans littéral regex contenant des caractères combinants (illisible et fragile).
 */
export function stripAccents(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFD")) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x0300 || cp > 0x036f) out += ch;
  }
  return out;
}


// ─── Sélection du corpus classifiable ───────────────────────────────────────

/** Un titre mentionnant un texte législatif porte une information exploitable. */
const RE_TEXTE_LEGISLATIF =
  /(projet de loi|proposition de loi|proposition de resolution|declaration du gouvernement)/;

/**
 * Votes de pure gestion de séance : prolongation, suspension, ordre du jour.
 * Sans rapport avec un engagement électoral, même lorsqu'ils sont rattachés à un
 * dossier législatif (ex. « la proposition du Gouvernement de prolonger la séance
 * en cours au-delà de vingt heures »).
 *
 * Formulé étroitement à dessein : « réserve » seul attraperait la « réserve
 * communale de sécurité civile », qui est un vrai texte de loi.
 */
const RE_GESTION_SEANCE =
  /(prolonger la seance|prolongation de la seance|suspension de (la )?seance|lever la seance|fixation de l'ordre du jour)/;

/** Catégorie éditoriale d'un scrutin. */
export function computeCategorie(scrutin: ScrutinAN): CategorieScrutin {
  const code = scrutin.typeVote?.codeTypeVote;
  const titre = normalizeText(scrutin.titre ?? "");

  if (code === "SPS") return "solennel";
  if (code === "MOC") return "motion_censure";
  if (titre.startsWith("l'ensemble")) return "ensemble_texte";
  if (titre.includes("amendement")) return "amendement";
  if (titre.includes("motion")) return "motion_procedure";
  return "autre";
}

/**
 * Le scrutin porte-t-il une information sémantique suffisante pour être classifié ?
 *
 * Mesuré sur la 17e législature : 1 212 scrutins éligibles sur 8 434 (14,4 %).
 * Les 7 221 votes d'amendements sont exclus — leur libellé
 * ("l'amendement n° 1762 de M. Le Coq à l'article 2 du projet de loi de finances")
 * ne dit rien du contenu de l'amendement, qui n'est pas dans Scrutins.json.
 * C'est la principale source de bruit du score : voir §1.2 de l'audit.
 */
export function isEligible(scrutin: ScrutinAN): boolean {
  const code = scrutin.typeVote?.codeTypeVote;
  const titre = normalizeText(scrutin.titre ?? "");
  const titreSansAccents = stripAccents(titre);

  // Votes solennels et motions de censure : toujours retenus.
  if (code === "SPS" || code === "MOC") return true;

  // Gestion de séance : aucun rapport avec un engagement électoral.
  if (RE_GESTION_SEANCE.test(titreSansAccents)) return false;

  // Vote final sur l'ensemble d'un texte : libellé toujours substantiel.
  if (titre.startsWith("l'ensemble")) return true;

  // Amendements et sous-amendements : jamais classifiables sans enrichissement.
  if (titre.includes("amendement")) return false;

  // Vote sur article : le titre nomme le texte parent, donc exploitable.
  // On accepte soit un dossier législatif rattaché, soit une mention explicite
  // d'un texte de loi (687 des 688 scrutins concernés en comportent une).
  const dossierRef = scrutin.objet?.dossierLegislatif?.dossierRef;
  return Boolean(dossierRef) || RE_TEXTE_LEGISLATIF.test(titreSansAccents);
}

/**
 * Résout le groupe d'un député À LA DATE DU VOTE.
 *
 * Sans cela, un député ayant changé de groupe verrait tous ses votes passés
 * réattribués à son nouveau groupe — exactement ce que le schéma documente
 * comme protection anti-manipulation, et que l'ETL ne faisait pas.
 * Repli sur le groupe actuel si l'historique ne couvre pas la date.
 */
export function resolveGroupeAtDate(
  deputeId: number,
  dateVote: string,
  historiqueParDepute: Map<number, GroupeHistoriqueRow[]>,
  groupeActuel: number,
): number {
  const lignes = historiqueParDepute.get(deputeId);
  if (!lignes || lignes.length === 0) return groupeActuel;

  for (const l of lignes) {
    const commence = l.date_debut <= dateVote;
    const finit = l.date_fin !== null && l.date_fin < dateVote;
    if (commence && !finit) return l.groupe_id;
  }
  return groupeActuel;
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
  const dossier = scrutin.objet?.dossierLegislatif ?? null;
  return {
    uid_an: scrutin.uid,
    numero,
    legislature,
    titre: (scrutin.titre ?? scrutin.objet?.libelle ?? "Sans titre").substring(0, 500),
    objet: scrutin.objet?.libelle ?? scrutin.titre ?? "Sans objet",
    // L'exposé des motifs n'est pas dans Scrutins.json : il faudrait joindre le
    // jeu de données des dossiers législatifs via dossier_ref.
    expose_des_motifs: null,
    date_scrutin: scrutin.dateScrutin,
    sort_adopte: isAdopte(scrutin),
    url_an: `https://www.assemblee-nationale.fr/dyn/${legislature}/scrutins/${numero}`,
    llm_traite: false,
    pertinent: null, // NULL = pas encore filtré (sémantique documentée du schéma)
    // ── Sprint 2 : métadonnées de sélection du corpus ──
    type_vote: scrutin.typeVote?.codeTypeVote ?? null,
    libelle_type_vote: scrutin.typeVote?.libelleTypeVote ?? null,
    categorie: computeCategorie(scrutin),
    dossier_ref: dossier?.dossierRef ?? null,
    dossier_libelle: dossier?.libelle ?? null,
    demandeur: scrutin.demandeur?.texte ?? null,
    eligible: isEligible(scrutin),
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
 * Extrait les mises au point d'un scrutin : rectifications de position déclarées
 * par les députés après le vote.
 *
 * Une mise au point ne change PAS le résultat officiel du scrutin — elle rectifie
 * la position individuelle consignée. Les ignorer exposerait le projet à des
 * démentis publics documentés ; on les stocke donc à part de `position_vote`,
 * dans `position_vote_corrigee`, pour que les deux restent inspectables.
 *
 * Renvoie une Map acteurRef → position rectifiée.
 */
export function extractMisesAuPoint(scrutin: ScrutinAN): Map<string, 1 | -1 | 0> {
  const corrections = new Map<string, 1 | -1 | 0>();
  const mp = scrutin.miseAuPoint;
  if (!mp) return corrections;

  const collecte = (
    entries: MiseAuPointEntry[] | MiseAuPointEntry | null | undefined,
    position: 1 | -1 | 0,
  ): void => {
    for (const entry of toArray(entries)) {
      // Les éléments `null` sont des artefacts de la conversion XML→JSON.
      if (!entry || !entry.votant) continue;
      for (const votant of toArray(entry.votant)) {
        if (votant?.acteurRef) corrections.set(votant.acteurRef, position);
      }
    }
  };

  collecte(mp.pours, 1);
  collecte(mp.contres, -1);
  collecte(mp.abstentions, 0);
  // nonVotants / nonVotantsVolontaires rectifiés : le député déclare n'avoir pas
  // voulu voter. Ce n'est pas une position exprimée, donc pas de correction.
  return corrections;
}

/**
 * Extrait les votes nominatifs d'un scrutin.
 *
 * ⚠️ Un député absent n'apparaît dans AUCUNE liste : il ne produit donc aucune
 *    ligne. L'absence n'est pas représentable ici — elle se déduit de
 *    `nombreMembresGroupe`. Voir §3.1 de l'audit.
 *
 * `groupe_id_au_moment_du_vote` est résolu via dim_depute_groupe_historique à la
 * date du scrutin : un député ayant changé de groupe ne voit pas ses votes passés
 * réattribués à son nouveau groupe.
 */
export function extractVoteRows(
  scrutin: ScrutinAN,
  scrutinDbId: number,
  deputeByUidAN: Map<string, DeputeRef>,
  historiqueParDepute: Map<number, GroupeHistoriqueRow[]> = new Map(),
): VoteRow[] {
  const rows: VoteRow[] = [];
  const groupes = toArray(scrutin.ventilationVotes?.organe?.groupes?.groupe);
  const corrections = extractMisesAuPoint(scrutin);

  for (const groupe of groupes) {
    const nomi = groupe.vote?.decompteNominatif;
    if (!nomi) continue;

    const push = (
      entry: { votant: Votant | Votant[] } | null | undefined,
      position: 1 | -1 | 0 | null,
    ): void => {
      if (!entry || !entry.votant) return;
      for (const votant of toArray(entry.votant)) {
        if (!votant?.acteurRef) continue;
        const depute = deputeByUidAN.get(votant.acteurRef);
        if (!depute) continue;

        const corrigee = corrections.get(votant.acteurRef);
        rows.push({
          scrutin_id: scrutinDbId,
          depute_id: depute.id,
          groupe_id_au_moment_du_vote: resolveGroupeAtDate(
            depute.id,
            scrutin.dateScrutin,
            historiqueParDepute,
            depute.groupe_id,
          ),
          position_vote: position,
          par_delegation: votant.parDelegation === "true",
          // Ne stocker la correction que si elle diffère réellement du vote consigné
          position_vote_corrigee: corrigee !== undefined && corrigee !== position ? corrigee : null,
        });
      }
    };

    push(nomi.pours, 1);
    push(nomi.contres, -1);
    push(nomi.abstentions, 0);
    push(nomi.nonVotants, null);
    push(nomi.nonVotantsVolontaires, null);
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

// ─── Contexte LLM reconstruit depuis la base ────────────────────────────────

/**
 * Variante de buildScrutinText() alimentée par une ligne de fact_scrutin.
 *
 * La phase de classification lit sa file d'attente en base et n'a donc plus
 * besoin du ZIP de l'Open Data : tout le contexte utile est persisté par la
 * phase d'ingestion.
 */
export function buildScrutinTextFromRow(row: ScrutinQueueRow): string {
  const lignes = [
    `SCRUTIN : ${row.uid_an} (n°${row.numero})`,
    `DATE : ${row.date_scrutin}`,
    `TYPE : ${row.libelle_type_vote ?? row.type_vote ?? "inconnu"}`,
    `OBJET : ${row.objet}`,
  ];
  if (row.dossier_libelle) lignes.push(`DOSSIER LÉGISLATIF : ${row.dossier_libelle}`);
  if (row.demandeur) lignes.push(`DEMANDÉ PAR : ${row.demandeur}`);
  lignes.push(`RÉSULTAT : ${row.sort_adopte ? "adopté" : "rejeté"}`);
  return lignes.join("\n");
}

// ─── Pré-filtrage thématique des promesses ──────────────────────────────────

/**
 * Mots-clés par thème (slugs de dim_theme), en minuscules SANS accent.
 *
 * Sert à réduire les ~1000 promesses candidates à quelques dizaines avant
 * l'appel LLM. Demander à un modèle de retrouver les liens pertinents parmi un
 * millier de candidats est le pire régime possible pour le rappel, et le terrain
 * idéal pour les identifiants hallucinés.
 *
 * Volontairement lexical : transparent, auditable, sans coût et sans dépendance.
 */
export const THEME_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "retraites": [
    "retraite", "pension", "age de depart", "carriere longue", "penibilite",
    "cotisation", "trimestre", "travail", "emploi", "chomage", "salarie", "syndicat",
  ],
  "fiscalite": [
    "impot", "fiscal", "taxe", "tva", "budget", "finances", "prelevement",
    "niche fiscale", "csg", "deficit", "dette", "credit d'impot", "douane", "recette",
  ],
  "immigration": [
    "immigration", "immigre", "etranger", "asile", "aide medicale", "titre de sejour",
    "naturalisation", "expulsion", "oqtf", "frontiere", "schengen", "nationalite", "migrant",
  ],
  "ecologie": [
    "ecologie", "climat", "carbone", "energie", "nucleaire", "renouvelable", "eolien",
    "pesticide", "biodiversite", "transition ecologique", "pollution", "environnement",
    "eau", "dechet", "agriculture",
  ],
  "sante": [
    "sante", "hopital", "medecin", "soin", "securite sociale", "desert medical",
    "psychiatrie", "medicament", "soignant", "hospitalier", "handicap", "dependance",
  ],
  "securite": [
    "securite", "police", "gendarmerie", "delinquance", "justice", "prison", "penal",
    "narcotrafic", "violence", "terrorisme", "magistrat", "surete", "fraude", "crime",
  ],
  "education": [
    "ecole", "education", "enseignant", "universite", "etudiant", "college", "lycee",
    "apprentissage", "formation", "scolaire", "jeunesse", "enfant", "recherche",
  ],
  "pouvoir-achat": [
    "pouvoir d'achat", "salaire", "smic", "prix", "inflation", "logement", "loyer",
    "allocation", "rsa", "minima", "consommation", "banque", "credit", "commerce",
  ],
  "institutions": [
    "constitution", "referendum", "election", "scrutin", "decentralisation",
    "collectivite", "elu local", "commune", "senat", "proportionnelle", "democratie",
    "municipal", "departement", "region", "outre-mer", "mayotte",
  ],
  "international": [
    "europe", "europeen", "union europeenne", "otan", "ukraine", "defense", "armee",
    "traite", "international", "cooperation", "mercosur", "etranger", "diplomatie",
  ],
};

/**
 * Détecte les thèmes plausibles d'un scrutin à partir de son libellé.
 * Renvoie les slugs triés par nombre de mots-clés trouvés (le plus pertinent d'abord).
 */
export function detectThemes(scrutinText: string): string[] {
  const texte = stripAccents(normalizeText(scrutinText));
  const scores: { slug: string; score: number }[] = [];

  for (const [slug, motsCles] of Object.entries(THEME_KEYWORDS)) {
    let score = 0;
    for (const mot of motsCles) {
      if (texte.includes(mot)) score++;
    }
    if (score > 0) scores.push({ slug, score });
  }
  return scores.sort((a, b) => b.score - a.score).map((s) => s.slug);
}

export interface PrefiltrageResult {
  candidates: Promesse[];
  themesDetectes: string[];
  repliToutesPromesses: boolean;
}

/**
 * Sélectionne les promesses à soumettre au LLM pour un scrutin donné.
 *
 * Si aucun thème n'est détecté, on retombe sur l'ensemble des promesses :
 * en matière de redevabilité, un lien manqué coûte plus cher que quelques
 * milliers de tokens supplémentaires.
 */
export function selectCandidatePromesses(
  scrutinText: string,
  promesses: Promesse[],
  themeSlugById: Map<number, string>,
  maxCandidates: number,
): PrefiltrageResult {
  const themesDetectes = detectThemes(scrutinText);

  if (themesDetectes.length === 0) {
    return { candidates: promesses, themesDetectes, repliToutesPromesses: true };
  }

  // Les promesses sont ajoutées thème par thème, du plus pertinent au moins
  // pertinent, jusqu'au plafond.
  const rang = new Map(themesDetectes.map((slug, i) => [slug, i]));
  const retenues = promesses
    .filter((p) => {
      const slug = themeSlugById.get(p.theme_id);
      return slug !== undefined && rang.has(slug);
    })
    .sort((a, b) => {
      const ra = rang.get(themeSlugById.get(a.theme_id)!) ?? Infinity;
      const rb = rang.get(themeSlugById.get(b.theme_id)!) ?? Infinity;
      return ra - rb || a.id - b.id;
    });

  if (retenues.length === 0) {
    return { candidates: promesses, themesDetectes, repliToutesPromesses: true };
  }
  return {
    candidates: retenues.slice(0, maxCandidates),
    themesDetectes,
    repliToutesPromesses: false,
  };
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
