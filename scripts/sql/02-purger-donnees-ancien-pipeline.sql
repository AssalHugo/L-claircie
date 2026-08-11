-- ============================================================
-- Purge des données produites par l'ancien pipeline
--
-- À lancer AVANT `npx supabase db push`, après une sauvegarde.
--
-- CE QUI EST CONSERVÉ (le coûteux, en argent comme en temps de relecture) :
--   dim_theme, dim_groupe, dim_depute, dim_depute_groupe_historique
--   dim_promesse  ← vos promesses extraites ET relues à la main
--
-- CE QUI EST SUPPRIMÉ, et pourquoi ces données sont irrécupérables :
--
--   fact_vote_individuel
--     `groupe_id_au_moment_du_vote` contient le groupe ACTUEL du député, pas
--     celui de la date du vote. C'est l'inverse de ce que le schéma documente
--     comme garantie anti-manipulation, et c'est irréparable sans réingestion :
--     l'information d'origine n'a jamais été écrite.
--     Manquent aussi `par_delegation` (15 % des votes) et les mises au point
--     (1 366 scrutins concernés).
--
--   fact_scrutin
--     Ni `type_vote`, ni `categorie`, ni `dossier_ref` : ces colonnes n'existaient
--     pas. `eligible` vaudrait donc false partout, et plus aucun scrutin ne
--     serait jamais classifié. `objet` a de plus été rempli avec le `titre`,
--     et le résultat du vote n'a jamais été renseigné.
--
--   llm_classification
--     Produites par un prompt qui recevait « RÉSULTAT : inconnu (0 pour, 0 contre) »
--     sur 100 % des scrutins, et qui comparait chaque scrutin à ~1 000 promesses
--     d'un coup — le pire régime pour le rappel. Elles portent en outre sur les
--     identifiants de promesses AVANT canonisation.
--
--   cache_score_groupe, cache_score_depute
--     Dérivées de tout ce qui précède.
--
-- La réingestion est gratuite (aucun appel LLM). Seule la reclassification a un
-- coût, chiffré dans DEPLOIEMENT.md.
-- ============================================================

\echo '=== AVANT ==='
SELECT 'fact_scrutin' AS table_, count(*) FROM fact_scrutin
UNION ALL SELECT 'fact_vote_individuel', count(*) FROM fact_vote_individuel
UNION ALL SELECT 'llm_classification',   count(*) FROM llm_classification
UNION ALL SELECT 'dim_promesse (conservé)', count(*) FROM dim_promesse
ORDER BY 1;

BEGIN;

-- Les caches n'existent pas forcément encore selon l'état des migrations.
DO $$
BEGIN
  IF to_regclass('public.cache_score_groupe') IS NOT NULL THEN
    EXECUTE 'TRUNCATE cache_score_groupe RESTART IDENTITY';
  END IF;
  IF to_regclass('public.cache_score_depute') IS NOT NULL THEN
    EXECUTE 'TRUNCATE cache_score_depute RESTART IDENTITY';
  END IF;
END $$;

-- Ordre imposé par les clés étrangères — les trois tables sont vidées ensemble.
TRUNCATE llm_classification, fact_vote_individuel, fact_scrutin RESTART IDENTITY;

COMMIT;

\echo ''
\echo '=== APRÈS ==='
SELECT 'fact_scrutin' AS table_, count(*) FROM fact_scrutin
UNION ALL SELECT 'fact_vote_individuel', count(*) FROM fact_vote_individuel
UNION ALL SELECT 'llm_classification',   count(*) FROM llm_classification
UNION ALL SELECT 'dim_promesse (conservé)', count(*) FROM dim_promesse
ORDER BY 1;

\echo ''
\echo 'Purge terminée. Étape suivante : npx supabase db push'
