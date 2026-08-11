-- ============================================================
-- Inspection d'une base existante — version SQL Editor du dashboard
--
-- Même contenu que 01-inspecter-base-existante.sql, mais en UNE SEULE requête :
-- l'éditeur du dashboard n'affiche que le résultat de la dernière instruction,
-- et ne comprend pas les commandes psql (\echo).
--
-- Aucun mot de passe requis : à coller tel quel dans SQL Editor → Run.
-- Lecture seule.
-- ============================================================

SELECT jsonb_pretty(jsonb_build_object(

  '1_volumetrie', (SELECT jsonb_object_agg(t, n) FROM (
      SELECT 'dim_theme' AS t, count(*) AS n FROM dim_theme
      UNION ALL SELECT 'dim_groupe',           count(*) FROM dim_groupe
      UNION ALL SELECT 'dim_depute',           count(*) FROM dim_depute
      UNION ALL SELECT 'dim_promesse',         count(*) FROM dim_promesse
      UNION ALL SELECT 'fact_scrutin',         count(*) FROM fact_scrutin
      UNION ALL SELECT 'fact_vote_individuel', count(*) FROM fact_vote_individuel
      UNION ALL SELECT 'llm_classification',   count(*) FROM llm_classification
  ) x),

  -- LE point à vérifier : si numero/titre/sort_adopte sont nullables, le schéma
  -- réel diverge du schéma versionné.
  '2_fact_scrutin_colonnes', (
      SELECT jsonb_object_agg(column_name, data_type || ' / nullable=' || is_nullable)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fact_scrutin'),

  '3_llm_classification_colonnes', (
      SELECT jsonb_object_agg(column_name, data_type || ' / nullable=' || is_nullable)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'llm_classification'),

  '4_objets_attendus_par_les_migrations', jsonb_build_object(
      'table promesse_groupe',    to_regclass('public.promesse_groupe')   IS NOT NULL,
      'table admin_utilisateur',  to_regclass('public.admin_utilisateur') IS NOT NULL,
      'dim_promesse.dedupe_hash', EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='dim_promesse' AND column_name='dedupe_hash'),
      'dim_promesse.canonical_id', EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='dim_promesse' AND column_name='canonical_id'),
      'fact_scrutin.eligible',    EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='fact_scrutin' AND column_name='eligible'),
      'fact_vote.par_delegation', EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='fact_vote_individuel' AND column_name='par_delegation')),

  '5_qualite_des_faits', (SELECT jsonb_build_object(
      'scrutins',     count(*),
      'sans_numero',  count(*) FILTER (WHERE numero IS NULL),
      'sans_titre',   count(*) FILTER (WHERE titre IS NULL),
      'sans_sort',    count(*) FILTER (WHERE sort_adopte IS NULL),
      'plus_ancien',  min(date_scrutin),
      'plus_recent',  max(date_scrutin)) FROM fact_scrutin),

  '6_promesses', (SELECT jsonb_build_object(
      'lignes',         count(*),
      'textes_uniques', count(DISTINCT lower(btrim(source_citation))),
      'validees',       count(*) FILTER (WHERE statut IN ('valide','auto')),
      'statuts',        (SELECT jsonb_object_agg(COALESCE(statut,'(null)'), n)
                         FROM (SELECT statut, count(*) AS n FROM dim_promesse
                               GROUP BY statut) s))
      FROM dim_promesse),

  '7_rls', (SELECT count(*) FILTER (WHERE rowsecurity) || '/' || count(*)
            FROM pg_tables WHERE schemaname='public'),

  '8_taille_base', pg_size_pretty(pg_database_size(current_database()))

)) AS inspection;
