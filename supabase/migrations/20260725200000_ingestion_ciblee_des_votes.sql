-- ============================================================
-- Suivi des votes ingérés
--
-- Permet à l'ETL de savoir quels scrutins ont leurs votes nominatifs en base,
-- donc de reprendre un backfill interrompu et de rattraper un périmètre élargi.
--
-- ── Pourquoi le périmètre par défaut est « TOUS les votes » ──
--
-- Le calcul du score de cohérence n'a besoin que des 1 198 scrutins éligibles
-- (198 844 votes). Mais les votes nominatifs servent aussi aux statistiques
-- comparatives — loyauté d'un député envers son groupe, proximité entre groupes,
-- cohésion — et celles-ci se dégraderaient à ne regarder que ce sous-ensemble :
-- les votes d'amendements sont précisément ceux où la discipline de groupe se
-- relâche. S'en priver ne réduirait pas seulement la précision, cela biaiserait
-- la mesure en SOUS-ESTIMANT systématiquement les dissidences.
--
-- Coût réel mesuré sur PostgreSQL 17.6 (et non estimé) :
--
--   fact_vote_individuel  1 270 476 lignes   63 Mo table + 79 Mo index = 143 Mo
--   fact_scrutin              8 434 lignes                                6 Mo
--   llm_classification        4 800 lignes                                2 Mo
--                                                              total ≈ 156 Mo
--
-- Soit 31 % du plafond de 500 Mo du plan gratuit. La marge est suffisante.
--
-- Levier disponible si le volume devenait un problème : la clé primaire `id`
-- de fact_vote_individuel coûte 27 Mo d'index et fait doublon avec l'index
-- unique naturel (depute_id, scrutin_id).
--
-- Le paramètre `votes` de l'ETL permet malgré tout de restreindre l'ingestion
-- aux scrutins éligibles ; la colonne ci-dessous rend le choix réversible dans
-- les deux sens.
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

ALTER TABLE "fact_scrutin"
  ADD COLUMN IF NOT EXISTS "votes_ingeres" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "fact_scrutin"."votes_ingeres" IS
  'true = les votes nominatifs de ce scrutin sont présents dans fact_vote_individuel. '
  'Permet de reprendre un backfill interrompu, et de rattraper les votes manquants '
  'si le périmètre d''ingestion est élargi après coup — sans tout ré-ingérer.';

-- Backfill : marquer les scrutins dont les votes sont déjà en base.
UPDATE "fact_scrutin" s
SET "votes_ingeres" = true
WHERE NOT s."votes_ingeres"
  AND EXISTS (SELECT 1 FROM "fact_vote_individuel" v WHERE v."scrutin_id" = s."id");

-- File de réparation. Le prédicat ne porte QUE sur votes_ingeres : l'index reste
-- utilisable que l'ETL tourne en périmètre complet ou restreint aux éligibles.
DROP INDEX IF EXISTS "idx_scrutin_votes_manquants";
CREATE INDEX IF NOT EXISTS "idx_scrutin_votes_manquants"
  ON "fact_scrutin" ("date_scrutin")
  WHERE "votes_ingeres" = false;

COMMIT;
