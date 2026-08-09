-- ============================================================
-- Row Level Security — politiques d'accès
--
-- CONSTAT CORRIGÉ ICI : aucune table n'avait RLS activé. Les tables créées par
-- migration SQL n'ont pas RLS par défaut (contrairement à celles créées depuis
-- le tableau de bord), et Supabase accorde à `anon` et `authenticated` tous les
-- droits DML — y compris TRUNCATE — sur chaque table du schéma public.
--
-- Vérifié sur la stack locale avec le seul rôle `anon`, celui de la clé publique
-- embarquée dans le bundle navigateur :
--   • lire les classifications en brouillon        → autorisé
--   • passer une classification en 'publie'        → autorisé
--   • réécrire cache_score_groupe                  → autorisé
--   • DELETE FROM fact_vote_individuel             → autorisé
--   • appeler refresh_scores()                     → autorisé
--
-- C'était la négation du principe fondateur « l'IA propose, l'humain valide ».
--
-- STRATÉGIE : refus par défaut.
--   1. RLS activé partout ;
--   2. droits d'écriture révoqués pour anon/authenticated (défense en profondeur :
--      une future politique trop permissive ne suffira pas à ouvrir l'écriture) ;
--   3. politiques SELECT explicites pour ce qui est réellement public ;
--   4. seules les données personnelles restent modifiables par leur propriétaire.
--
-- service_role possède BYPASSRLS : l'ETL et les Server Actions d'administration
-- ne sont pas affectés.
--
-- ⚠️ NE FERME PAS le second trou : la route /admin n'a aucune authentification
--    et utilise service_role, qui contourne RLS par conception. Cela relève d'un
--    contrôle d'accès applicatif (middleware Next.js), pas de la base.
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Activer RLS sur toutes les tables métier
-- ────────────────────────────────────────────────────────────

ALTER TABLE "dim_groupe"                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dim_depute"                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dim_depute_groupe_historique"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dim_theme"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dim_promesse"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promesse_groupe"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_scrutin"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_vote_individuel"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_classification"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cache_score_groupe"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cache_score_depute"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "etl_run_log"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_preferences"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_alertes"                  ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 2. Révoquer l'écriture pour les rôles publics
--
-- RLS suffit à bloquer, mais retirer les privilèges est une seconde barrière :
-- si quelqu'un ajoute un jour une politique permissive par erreur, l'absence
-- de privilège table empêche encore l'écriture.
-- ────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dim_groupe', 'dim_depute', 'dim_depute_groupe_historique', 'dim_theme',
    'dim_promesse', 'promesse_groupe', 'fact_scrutin', 'fact_vote_individuel',
    'llm_classification', 'cache_score_groupe', 'cache_score_depute', 'etl_run_log'
  ] LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM anon, authenticated',
      t
    );
  END LOOP;
END $$;

-- Les tables de données personnelles gardent l'écriture, filtrée par politique.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "user_preferences", "user_alertes"
  FROM anon, authenticated;
REVOKE ALL ON TABLE "user_preferences", "user_alertes" FROM anon;

-- ────────────────────────────────────────────────────────────
-- 3. Données de référence — publiques intégralement
--
-- Ce sont des données ouvertes de l'Assemblée nationale : les republier
-- telles quelles ne pose aucun problème, et c'est même l'objet du projet.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "lecture_publique" ON "dim_groupe";
CREATE POLICY "lecture_publique" ON "dim_groupe"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "dim_depute";
CREATE POLICY "lecture_publique" ON "dim_depute"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "dim_depute_groupe_historique";
CREATE POLICY "lecture_publique" ON "dim_depute_groupe_historique"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "dim_theme";
CREATE POLICY "lecture_publique" ON "dim_theme"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "fact_scrutin";
CREATE POLICY "lecture_publique" ON "fact_scrutin"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "fact_vote_individuel";
CREATE POLICY "lecture_publique" ON "fact_vote_individuel"
  FOR SELECT TO anon, authenticated USING (true);

-- ────────────────────────────────────────────────────────────
-- 4. Promesses — uniquement celles qui ont passé la relecture
--
-- Une promesse au statut NULL ou 'review' n'a pas été validée : la publier
-- reviendrait à exposer une extraction brute de LLM comme un engagement avéré.
-- Les doublons issus des programmes communs sont masqués (est_canonique).
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "lecture_promesses_validees" ON "dim_promesse";
CREATE POLICY "lecture_promesses_validees" ON "dim_promesse"
  FOR SELECT TO anon, authenticated
  USING ("est_canonique" = true AND "statut" IN ('auto', 'valide', 'active'));

DROP POLICY IF EXISTS "lecture_liaisons_publiees" ON "promesse_groupe";
CREATE POLICY "lecture_liaisons_publiees" ON "promesse_groupe"
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM "dim_promesse" p
    WHERE p."id" = "promesse_groupe"."promesse_id"
      AND p."est_canonique" = true
      AND p."statut" IN ('auto', 'valide', 'active')
  ));

-- ────────────────────────────────────────────────────────────
-- 5. Classifications LLM — LE verrou du workflow humain
--
-- C'est la politique la plus importante du fichier. Une classification en
-- 'brouillon' est une proposition de l'IA que personne n'a relue : elle ne doit
-- jamais être visible publiquement, ni entrer dans un score affiché.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "lecture_classifications_publiees" ON "llm_classification";
CREATE POLICY "lecture_classifications_publiees" ON "llm_classification"
  FOR SELECT TO anon, authenticated
  USING ("statut_publication" = 'publie');

-- ────────────────────────────────────────────────────────────
-- 6. Scores — publics en lecture
--
-- Y compris les lignes publiable = false : l'interface doit pouvoir afficher
-- 🌫️ « Données insuffisantes » plutôt qu'une absence inexpliquée.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "lecture_publique" ON "cache_score_groupe";
CREATE POLICY "lecture_publique" ON "cache_score_groupe"
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lecture_publique" ON "cache_score_depute";
CREATE POLICY "lecture_publique" ON "cache_score_depute"
  FOR SELECT TO anon, authenticated USING (true);

-- ────────────────────────────────────────────────────────────
-- 7. etl_run_log — aucune politique, donc aucun accès public
--
-- Contient les coûts d'API et les traces d'erreur. Aucune politique n'est créée :
-- avec RLS actif, l'absence de politique vaut refus.
-- ────────────────────────────────────────────────────────────

-- (volontairement vide)

-- ────────────────────────────────────────────────────────────
-- 8. Données personnelles — chacun ne voit que les siennes
--
-- Ces politiques dépendent de Supabase Auth (fonction auth.uid()). Sur une
-- instance Postgres sans le schéma auth, elles ne sont pas créées : RLS reste
-- actif sans politique, donc l'accès est refusé — le comportement sûr.
-- ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $pol$
      DROP POLICY IF EXISTS "proprietaire_seul" ON "user_preferences";
      CREATE POLICY "proprietaire_seul" ON "user_preferences"
        FOR ALL TO authenticated
        USING (auth.uid() = "user_id")
        WITH CHECK (auth.uid() = "user_id");
    $pol$;
    EXECUTE $pol$
      DROP POLICY IF EXISTS "proprietaire_seul" ON "user_alertes";
      CREATE POLICY "proprietaire_seul" ON "user_alertes"
        FOR ALL TO authenticated
        USING (auth.uid() = "user_id")
        WITH CHECK (auth.uid() = "user_id");
    $pol$;
  ELSE
    RAISE NOTICE
      'Schéma auth absent : politiques user_preferences/user_alertes non créées. '
      'RLS reste actif sans politique, donc accès refusé (comportement sûr).';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- 9. Fonctions et vues internes
-- ────────────────────────────────────────────────────────────

-- refresh_scores() réécrit intégralement les scores affichés : réservée au
-- pipeline. Sans cette révocation, un visiteur peut la déclencher via
-- POST /rest/v1/rpc/refresh_scores avec la seule clé publique.
REVOKE ALL ON FUNCTION "refresh_scores"(numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "refresh_scores"(numeric, numeric, numeric, numeric, numeric, numeric, numeric)
  TO service_role;

-- v_alignement expose les classifications SANS filtre de publication.
-- Une vue s'exécute par défaut avec les droits de son propriétaire, ce qui
-- contournerait la RLS des tables sous-jacentes : on force security_invoker
-- ET on retire l'accès aux rôles publics.
ALTER VIEW "v_alignement" SET (security_invoker = true);
REVOKE ALL ON "v_alignement" FROM PUBLIC, anon, authenticated;
GRANT SELECT ON "v_alignement" TO service_role;

-- label_meteo() et score_intervalle() sont des fonctions de calcul pures, sans
-- accès aux données : elles restent exécutables publiquement, ce qui permet à
-- un tiers de refaire le calcul lui-même.

COMMIT;
