-- ============================================================
-- Inspection d'une base existante avant application des migrations
--
-- À lancer AVANT `npx supabase db push` sur un projet déjà peuplé.
-- Lecture seule : n'écrit rien.
--
-- Objectif : détecter les divergences entre le schéma réel et le schéma
-- versionné. Elles existent (c'est ainsi que l'ancien ETL a pu insérer des
-- scrutins malgré des colonnes NOT NULL manquantes dans civic_tech.sql), et
-- elles peuvent faire échouer une migration.
-- ============================================================

\echo '=== 1. Volumétrie ==='
SELECT 'dim_theme' AS table_, count(*) FROM dim_theme
UNION ALL SELECT 'dim_groupe',            count(*) FROM dim_groupe
UNION ALL SELECT 'dim_depute',            count(*) FROM dim_depute
UNION ALL SELECT 'dim_promesse',          count(*) FROM dim_promesse
UNION ALL SELECT 'fact_scrutin',          count(*) FROM fact_scrutin
UNION ALL SELECT 'fact_vote_individuel',  count(*) FROM fact_vote_individuel
UNION ALL SELECT 'llm_classification',    count(*) FROM llm_classification
ORDER BY 1;

\echo ''
\echo '=== 2. Colonnes de fact_scrutin (nullable ? colonnes Sprint 2 présentes ?) ==='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fact_scrutin'
ORDER BY ordinal_position;

\echo ''
\echo '=== 3. Colonnes de llm_classification (statut ou statut_validation ?) ==='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'llm_classification'
ORDER BY ordinal_position;

\echo ''
\echo '=== 4. Tables et colonnes attendues par les migrations ==='
SELECT 'promesse_groupe (table)'            AS objet,
       to_regclass('public.promesse_groupe') IS NOT NULL AS present
UNION ALL SELECT 'admin_utilisateur (table)',
       to_regclass('public.admin_utilisateur') IS NOT NULL
UNION ALL SELECT 'dim_promesse.dedupe_hash',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='dim_promesse' AND column_name='dedupe_hash')
UNION ALL SELECT 'dim_promesse.canonical_id',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='dim_promesse' AND column_name='canonical_id')
UNION ALL SELECT 'fact_scrutin.eligible',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='fact_scrutin' AND column_name='eligible')
UNION ALL SELECT 'fact_vote_individuel.par_delegation',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='fact_vote_individuel' AND column_name='par_delegation');

\echo ''
\echo '=== 5. Qualité des données de faits existantes ==='
SELECT
  count(*)                                    AS scrutins,
  count(*) FILTER (WHERE numero IS NULL)      AS sans_numero,
  count(*) FILTER (WHERE titre IS NULL)       AS sans_titre,
  count(*) FILTER (WHERE sort_adopte IS NULL) AS sans_sort,
  min(date_scrutin)                           AS plus_ancien,
  max(date_scrutin)                           AS plus_recent
FROM fact_scrutin;

\echo ''
\echo '=== 6. Promesses : doublons de programmes communs ==='
SELECT
  count(*)                                          AS lignes,
  count(DISTINCT lower(btrim(source_citation)))     AS textes_uniques,
  count(*) FILTER (WHERE statut IN ('valide','auto')) AS validees
FROM dim_promesse;

\echo ''
\echo '=== 7. RLS active ? ==='
SELECT count(*) FILTER (WHERE rowsecurity) || '/' || count(*) AS rls_actives
FROM pg_tables WHERE schemaname = 'public';

\echo ''
\echo '=== 8. Taille de la base ==='
SELECT pg_size_pretty(pg_database_size(current_database())) AS taille;
