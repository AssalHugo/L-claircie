-- ============================================================
-- Ingestion ciblée des votes
--
-- Les votes ne sont chargés que pour les scrutins ÉLIGIBLES au calcul du score.
--
-- Mesuré sur la 17e législature : 1 198 scrutins éligibles sur 8 434. Les 7 221
-- votes d'amendements n'entrent dans aucun calcul (leur libellé ne permet aucune
-- classification fiable — §1.2 de l'audit), mais représentaient l'essentiel du
-- volume :
--
--   tout ingérer            → ~1 270 000 lignes, 150 à 250 Mo avec index
--   éligibles seulement     →   ~180 000 lignes, ~30 Mo
--
-- Le plan gratuit Supabase est limité à 500 Mo. Le premier cas passait tout
-- juste, sans marge pour la suite de la législature.
--
-- Les scrutins non éligibles restent INSÉRÉS dans fact_scrutin : ils pèsent
-- quelques mégaoctets, servent de clé de déduplication à l'ETL (sans eux, ils
-- seraient redétectés comme nouveaux à chaque run) et documentent le
-- dénominateur réel — « 1 198 scrutins analysés sur 8 434 ».
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

ALTER TABLE "fact_scrutin"
  ADD COLUMN IF NOT EXISTS "votes_ingeres" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "fact_scrutin"."votes_ingeres" IS
  'true = les votes nominatifs de ce scrutin sont présents dans fact_vote_individuel. '
  'Rend la restriction RÉVERSIBLE : si la règle d''éligibilité s''élargit un jour '
  '(enrichissement des amendements en V2), l''ETL retrouve les scrutins devenus '
  'éligibles dont les votes manquent — sans quoi il faudrait tout ré-ingérer.';

-- Backfill : marquer les scrutins dont les votes sont déjà en base.
UPDATE "fact_scrutin" s
SET "votes_ingeres" = true
WHERE NOT s."votes_ingeres"
  AND EXISTS (SELECT 1 FROM "fact_vote_individuel" v WHERE v."scrutin_id" = s."id");

-- File de réparation : scrutins éligibles dont les votes manquent encore.
CREATE INDEX IF NOT EXISTS "idx_scrutin_votes_manquants"
  ON "fact_scrutin" ("date_scrutin")
  WHERE "eligible" = true AND "votes_ingeres" = false;

COMMIT;
