-- ============================================================
-- Sprint 2 — Fiabilisation de l'entrée du pipeline
--
-- 1. fact_scrutin  : métadonnées de filtrage du corpus (type de vote,
--                    dossier législatif, demandeur, éligibilité)
-- 2. fact_vote_individuel : vote par délégation + mise au point
-- 3. dim_promesse  : promesses CANONIQUES + table de liaison promesse_groupe
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. fact_scrutin — sélection du corpus classifiable
-- ────────────────────────────────────────────────────────────

ALTER TABLE "fact_scrutin"
  ADD COLUMN IF NOT EXISTS "type_vote"         varchar(10),
  ADD COLUMN IF NOT EXISTS "libelle_type_vote" varchar(100),
  ADD COLUMN IF NOT EXISTS "categorie"         varchar(24),
  ADD COLUMN IF NOT EXISTS "dossier_ref"       varchar(50),
  ADD COLUMN IF NOT EXISTS "dossier_libelle"   text,
  ADD COLUMN IF NOT EXISTS "demandeur"         text,
  ADD COLUMN IF NOT EXISTS "eligible"          boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "fact_scrutin"."type_vote" IS
  'Code AN typeVote.codeTypeVote : ''SPS'' (solennel), ''SPO'' (ordinaire), ''MOC'' (motion de censure).';
COMMENT ON COLUMN "fact_scrutin"."categorie" IS
  'Catégorie éditoriale dérivée du titre : solennel | motion_censure | ensemble_texte | motion_procedure | amendement | autre.';
COMMENT ON COLUMN "fact_scrutin"."dossier_ref" IS
  'objet.dossierLegislatif.dossierRef, ex: ''DLR5L17N50579''. Clé de jointure vers les dossiers législatifs.';
COMMENT ON COLUMN "fact_scrutin"."demandeur" IS
  'demandeur.texte, ex: ''Présidente du groupe "Rassemblement National"''. Signal de contexte pour le LLM.';
COMMENT ON COLUMN "fact_scrutin"."eligible" IS
  'true = scrutin dont le libellé porte une information sémantique exploitable, donc classifiable. '
  'Mesuré sur la 17e législature : 1212 scrutins éligibles sur 8434 (14,4%). '
  'Les 7221 votes d''amendements sont exclus : leur libellé ("l''amendement n° 1762 de M. X à l''article 2") '
  'ne permet aucune classification fiable.';

-- File d'attente de classification : remplace le plafond en mémoire du run.
-- Un scrutin éligible non classifié y reste jusqu'à traitement effectif.
CREATE INDEX IF NOT EXISTS "idx_scrutin_queue_classification"
  ON "fact_scrutin" ("date_scrutin")
  WHERE "eligible" = true AND "llm_traite" = false;

CREATE INDEX IF NOT EXISTS "idx_scrutin_eligible" ON "fact_scrutin" ("eligible");
CREATE INDEX IF NOT EXISTS "idx_scrutin_dossier" ON "fact_scrutin" ("dossier_ref");

-- ────────────────────────────────────────────────────────────
-- 2. fact_vote_individuel — délégation et mise au point
-- ────────────────────────────────────────────────────────────

ALTER TABLE "fact_vote_individuel"
  ADD COLUMN IF NOT EXISTS "par_delegation"          boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "position_vote_corrigee"  smallint;

COMMENT ON COLUMN "fact_vote_individuel"."par_delegation" IS
  'true si le vote a été émis par procuration (champ parDelegation du JSON AN). '
  '15% des votes de la 17e législature. Compte pour la cohérence, JAMAIS pour la présence.';
COMMENT ON COLUMN "fact_vote_individuel"."position_vote_corrigee" IS
  'Position déclarée par le député en "mise au point" après le scrutin (1/-1/0), NULL si aucune. '
  'Une mise au point ne change pas le résultat officiel du vote mais rectifie la position affichée. '
  'Le calcul du score doit utiliser COALESCE(position_vote_corrigee, position_vote).';

-- ────────────────────────────────────────────────────────────
-- 3. dim_promesse — promesses canoniques
--
-- Problème corrigé : les programmes communs (NFP → 4 groupes,
-- Ensemble → 3 groupes) étaient dupliqués en lignes distinctes.
-- Un texte identique recevait un id différent par groupe, était
-- classifié N fois par le LLM, et pouvait donc obtenir des polarités
-- divergentes — faisant diverger les scores de groupes signataires
-- du même programme pour de pures raisons de bruit stochastique.
-- ────────────────────────────────────────────────────────────

ALTER TABLE "dim_promesse"
  ADD COLUMN IF NOT EXISTS "canonical_id"            int,
  ADD COLUMN IF NOT EXISTS "est_canonique"           boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "dedupe_hash_canonique"   char(64);

COMMENT ON COLUMN "dim_promesse"."canonical_id" IS
  'Identifiant de la promesse canonique représentant ce texte. Égal à id pour la promesse canonique elle-même.';
COMMENT ON COLUMN "dim_promesse"."est_canonique" IS
  'true = ligne de référence utilisée pour la classification LLM et le calcul du score. '
  'Les doublons issus des programmes communs restent en base (traçabilité) mais sont ignorés.';
COMMENT ON COLUMN "dim_promesse"."dedupe_hash_canonique" IS
  'SHA-256 de la citation source normalisée, SANS groupe_id. Clé de dédoublonnage inter-groupes.';

-- Table de liaison promesse ↔ groupes signataires
CREATE TABLE IF NOT EXISTS "promesse_groupe" (
  "id"              SERIAL PRIMARY KEY,
  "promesse_id"     int NOT NULL REFERENCES "dim_promesse" ("id") ON DELETE CASCADE,
  "groupe_id"       int NOT NULL REFERENCES "dim_groupe" ("id"),
  "type_engagement" varchar(24) NOT NULL DEFAULT 'programme_propre',
  "source_pdf_nom"  varchar(200),
  "created_at"      timestamptz NOT NULL DEFAULT (now())
);

COMMENT ON TABLE "promesse_groupe" IS
  'Quels groupes portent quelle promesse. Une promesse issue d''un programme de coalition '
  'est rattachée à plusieurs groupes sans être dupliquée.';
COMMENT ON COLUMN "promesse_groupe"."type_engagement" IS
  'ENUM logique : ''programme_propre'' (document publié par ce seul groupe) | '
  '''programme_coalition'' (programme commun signé par plusieurs groupes — NFP, Ensemble). '
  'Doit être affiché en UI : c''est une hypothèse éditoriale qui doit rester inspectable.';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_promesse_groupe"
  ON "promesse_groupe" ("promesse_id", "groupe_id");
CREATE INDEX IF NOT EXISTS "idx_promesse_groupe_groupe"
  ON "promesse_groupe" ("groupe_id");

-- ── 3a. Backfill : désigner une promesse canonique par texte identique ──
-- La citation source est la preuve inattaquable : deux promesses portant
-- exactement la même citation sont le même engagement.
WITH canon AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY lower(btrim("source_citation"))) AS "canonical_id"
  FROM "dim_promesse"
)
UPDATE "dim_promesse" p
SET "canonical_id" = c."canonical_id"
FROM canon c
WHERE p."id" = c."id"
  AND p."canonical_id" IS DISTINCT FROM c."canonical_id";

UPDATE "dim_promesse"
SET "est_canonique" = ("canonical_id" = "id")
WHERE "est_canonique" IS DISTINCT FROM ("canonical_id" = "id");

-- ── 3b. Backfill : peupler promesse_groupe depuis les lignes existantes ──
INSERT INTO "promesse_groupe" ("promesse_id", "groupe_id", "source_pdf_nom")
SELECT DISTINCT p."canonical_id", p."groupe_id", p."source_pdf_nom"
FROM "dim_promesse" p
WHERE p."canonical_id" IS NOT NULL
ON CONFLICT ("promesse_id", "groupe_id") DO NOTHING;

-- Une promesse rattachée à plusieurs groupes provient d'un programme de coalition.
UPDATE "promesse_groupe"
SET "type_engagement" = 'programme_coalition'
WHERE "promesse_id" IN (
  SELECT "promesse_id" FROM "promesse_groupe" GROUP BY "promesse_id" HAVING count(*) > 1
)
AND "type_engagement" <> 'programme_coalition';

-- ── 3c. Repointer les classifications existantes vers les promesses canoniques ──
-- D'abord supprimer celles qui deviendraient des doublons sur (scrutin_id, promesse_id),
-- en conservant la plus ancienne.
DELETE FROM "llm_classification" lc
USING "dim_promesse" p, "llm_classification" lc2, "dim_promesse" p2
WHERE lc."promesse_id" = p."id"
  AND lc2."promesse_id" = p2."id"
  AND p."canonical_id" = p2."canonical_id"
  AND lc."scrutin_id" = lc2."scrutin_id"
  AND lc."id" > lc2."id";

UPDATE "llm_classification" lc
SET "promesse_id" = p."canonical_id"
FROM "dim_promesse" p
WHERE lc."promesse_id" = p."id"
  AND p."canonical_id" <> p."id";

-- ── 3d. Auto-référencement de canonical_id à l'insertion ──
-- Une nouvelle promesse est canonique par défaut. Le trigger évite au script
-- d'extraction un aller-retour INSERT puis UPDATE pour se pointer lui-même.
CREATE OR REPLACE FUNCTION "set_promesse_canonical_default"()
RETURNS trigger AS $$
BEGIN
  IF NEW."canonical_id" IS NULL THEN
    NEW."canonical_id" := NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_promesse_canonical" ON "dim_promesse";
CREATE TRIGGER "trg_promesse_canonical"
  BEFORE INSERT ON "dim_promesse"
  FOR EACH ROW EXECUTE FUNCTION "set_promesse_canonical_default"();

-- ── 3e. Verrouiller l'invariant ──
ALTER TABLE "dim_promesse" ALTER COLUMN "canonical_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_promesse_canonical'
  ) THEN
    ALTER TABLE "dim_promesse"
      ADD CONSTRAINT "fk_promesse_canonical"
      FOREIGN KEY ("canonical_id") REFERENCES "dim_promesse" ("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_promesse_canonique"
  ON "dim_promesse" ("est_canonique") WHERE "est_canonique" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_promesse_dedupe_canonique"
  ON "dim_promesse" ("dedupe_hash_canonique")
  WHERE "dedupe_hash_canonique" IS NOT NULL;

COMMIT;
