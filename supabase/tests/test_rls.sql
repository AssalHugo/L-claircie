-- ============================================================
-- Tests des politiques RLS
--
-- Rejoue, avec le rôle `anon` (celui de la clé publique embarquée dans le
-- bundle navigateur), chacune des attaques qui réussissaient avant la
-- migration 20260725160000_rls_politiques_acces.sql.
--
-- Exécution :
--   npx supabase db reset
--   docker cp supabase/tests/test_rls.sql supabase_db_<projet>:/tmp/
--   docker exec supabase_db_<projet> psql -U postgres -d postgres -f /tmp/test_rls.sql
--
-- Le script tourne dans une transaction annulée : il n'écrit rien durablement.
-- Sortie : une ligne OK par contrôle, ou une exception au premier écart.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual anyelement, p_expected anyelement
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ECHEC — % : attendu %, obtenu %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE 'OK   — % (%)', p_label, p_actual;
END;
$$;

-- ─── Jeu d'essai, inséré en tant que postgres (BYPASSRLS) ───────────────────

INSERT INTO dim_groupe (id, uid_officiel, sigle, nom_complet, couleur_hex, nb_sieges)
VALUES (980, 'PO980', 'RLS', 'Groupe test RLS', '#000000', 1);
INSERT INTO dim_theme (id, slug, label) VALUES (980, 'rls', 'RLS');

-- Une promesse validée (publique) et une en attente de relecture (privée)
INSERT INTO dim_promesse (id, groupe_id, theme_id, intitule_court, source_pdf_nom,
                          source_pdf_page, source_citation, statut, canonical_id, est_canonique)
VALUES
  (980, 980, 980, 'promesse validee', 'f.pdf', 1, 'c1', 'valide', 980, true),
  (981, 980, 980, 'promesse a relire', 'f.pdf', 2, 'c2', 'review', 981, true);

INSERT INTO promesse_groupe (promesse_id, groupe_id) VALUES (980, 980), (981, 980);

INSERT INTO fact_scrutin (id, uid_an, numero, legislature, titre, objet, date_scrutin, sort_adopte)
VALUES (980, 'VTRLS', 980, 17, 't', 'o', DATE '2025-01-01', true);

-- Une classification publiée et une en brouillon
INSERT INTO llm_classification (scrutin_id, promesse_id, polarite_llm, confidence_score,
                                statut_validation, statut_publication, modele_llm, prompt_hash)
VALUES
  (980, 980, 1, 0.9, 'valide', 'publie',    'test', repeat('x', 64)),
  (980, 981, 1, 0.9, 'auto',   'brouillon', 'test', repeat('y', 64));

INSERT INTO etl_run_log (run_type, statut, cout_llm_usd, detail_erreur)
VALUES ('daily_etl', 'success', 1.234567, 'trace interne confidentielle');

INSERT INTO cache_score_groupe (groupe_id, theme_id, score_0_100, score_brut, nb_scrutins, label_meteo)
VALUES (980, NULL, 75, 0.5, 10, 'eclaircies');

-- ═══════════════════════════════════════════════════════════════════════════
-- LECTURES — ce que voit un visiteur muni de la seule clé publique
-- ═══════════════════════════════════════════════════════════════════════════

SET ROLE anon;

DO $$
DECLARE v_n int;
BEGIN
  -- LA politique critique : les propositions non relues de l'IA restent invisibles.
  SELECT count(*) INTO v_n FROM llm_classification WHERE scrutin_id = 980;
  PERFORM pg_temp.assert_eq('anon ne voit que les classifications publiees', v_n, 1);

  SELECT count(*) INTO v_n FROM llm_classification WHERE statut_publication = 'brouillon';
  PERFORM pg_temp.assert_eq('anon ne voit AUCUN brouillon', v_n, 0);

  -- Une promesse en 'review' est une extraction brute de LLM : pas un engagement avéré.
  SELECT count(*) INTO v_n FROM dim_promesse WHERE id IN (980, 981);
  PERFORM pg_temp.assert_eq('anon ne voit que les promesses validees', v_n, 1);

  SELECT count(*) INTO v_n FROM promesse_groupe WHERE promesse_id IN (980, 981);
  PERFORM pg_temp.assert_eq('anon ne voit que les liaisons publiables', v_n, 1);

  -- Journal interne : coûts d'API et traces d'erreur.
  SELECT count(*) INTO v_n FROM etl_run_log;
  PERFORM pg_temp.assert_eq('anon ne voit pas le journal ETL', v_n, 0);

  -- Les données personnelles vont plus loin que RLS : le privilège lui-même est
  -- retiré à anon, donc l'accès est refusé avant même l'évaluation des politiques.
  DECLARE v_resultat text;
  BEGIN
    BEGIN
      PERFORM count(*) FROM user_preferences;
      v_resultat := 'AUTORISE';
    EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
    END;
    PERFORM pg_temp.assert_eq('anon ne peut PAS lire les preferences utilisateurs', v_resultat, 'refuse');
  END;

  -- Ce qui DOIT rester lisible : sans cela le site public ne fonctionne plus.
  SELECT count(*) INTO v_n FROM dim_groupe WHERE id = 980;
  PERFORM pg_temp.assert_eq('anon lit les groupes', v_n, 1);

  SELECT count(*) INTO v_n FROM fact_scrutin WHERE id = 980;
  PERFORM pg_temp.assert_eq('anon lit les scrutins', v_n, 1);

  SELECT count(*) INTO v_n FROM cache_score_groupe WHERE groupe_id = 980;
  PERFORM pg_temp.assert_eq('anon lit les scores', v_n, 1);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ÉCRITURES — chacune de ces attaques réussissait avant la migration
-- ═══════════════════════════════════════════════════════════════════════════

-- Chaque tentative est encapsulée : 'refuse' si l'ordre est bloqué, 'AUTORISE' sinon.
DO $$
DECLARE v_resultat text;
BEGIN
  BEGIN
    UPDATE llm_classification SET statut_publication = 'publie' WHERE scrutin_id = 980;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS publier une classification', v_resultat, 'refuse');

  BEGIN
    UPDATE cache_score_groupe SET score_0_100 = 100 WHERE groupe_id = 980;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS reecrire les scores', v_resultat, 'refuse');

  BEGIN
    DELETE FROM fact_vote_individuel;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS supprimer les votes', v_resultat, 'refuse');

  BEGIN
    INSERT INTO dim_promesse (groupe_id, theme_id, intitule_court, source_pdf_nom,
                              source_pdf_page, source_citation, statut)
    VALUES (980, 980, 'promesse injectee', 'faux.pdf', 1, 'fausse citation', 'valide');
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS injecter une promesse', v_resultat, 'refuse');

  BEGIN
    UPDATE dim_promesse SET intitule_court = 'falsifie' WHERE id = 980;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS falsifier une promesse', v_resultat, 'refuse');

  BEGIN
    PERFORM refresh_scores();
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS declencher refresh_scores()', v_resultat, 'refuse');

  -- v_alignement expose les classifications sans filtre de publication.
  BEGIN
    PERFORM count(*) FROM v_alignement;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS lire la vue v_alignement', v_resultat, 'refuse');

  BEGIN
    TRUNCATE fact_scrutin CASCADE;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS vider une table', v_resultat, 'refuse');
END $$;

RESET ROLE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Autorisation de l'administration
--
-- La table admin_utilisateur est la source d'autorisation de /admin. On simule
-- ici ce que fait PostgREST : rôle `authenticated` + claim JWT `sub`.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO admin_utilisateur (user_id, email, nom, actif) VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin@test.fr',   'Admin',   true),
  ('22222222-2222-2222-2222-222222222222', 'revoque@test.fr', 'Revoque', false);

DO $$
DECLARE v_n int; v_resultat text;
BEGIN
  -- Un administrateur actif voit sa propre ligne — c'est ce qui prouve
  -- l'autorisation à getAdminConnecte().
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
  SELECT count(*) INTO v_n FROM admin_utilisateur;
  PERFORM pg_temp.assert_eq('admin actif voit sa propre ligne', v_n, 1);

  -- Un utilisateur authentifié quelconque ne voit rien : il n'est pas admin.
  SET LOCAL request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999"}';
  SELECT count(*) INTO v_n FROM admin_utilisateur;
  PERFORM pg_temp.assert_eq('utilisateur non admin ne voit aucune ligne', v_n, 0);

  -- Un accès révoqué (actif = false) ne voit plus rien non plus.
  SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222"}';
  SELECT count(*) INTO v_n FROM admin_utilisateur;
  PERFORM pg_temp.assert_eq('admin revoque ne voit plus sa ligne', v_n, 0);

  -- Un administrateur ne peut pas s'octroyer de droits ni en octroyer.
  SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';
  BEGIN
    INSERT INTO admin_utilisateur (user_id, email)
    VALUES ('33333333-3333-3333-3333-333333333333', 'complice@test.fr');
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('un admin ne peut PAS en ajouter un autre', v_resultat, 'refuse');

  RESET ROLE;
END $$;

RESET ROLE;

DO $$
DECLARE v_resultat text;
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM count(*) FROM admin_utilisateur;
    v_resultat := 'AUTORISE';
  EXCEPTION WHEN insufficient_privilege THEN v_resultat := 'refuse';
  END;
  PERFORM pg_temp.assert_eq('anon ne peut PAS lire la liste des admins', v_resultat, 'refuse');
  RESET ROLE;
END $$;

RESET ROLE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Le pipeline doit continuer de fonctionner (service_role a BYPASSRLS)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int; v_bypass boolean;
BEGIN
  SELECT rolbypassrls INTO v_bypass FROM pg_roles WHERE rolname = 'service_role';
  PERFORM pg_temp.assert_eq('service_role contourne RLS (ETL + admin intacts)', v_bypass, true);

  SELECT count(*) INTO v_n FROM llm_classification WHERE scrutin_id = 980;
  PERFORM pg_temp.assert_eq('postgres voit toujours toutes les classifications', v_n, 2);

  RAISE NOTICE '';
  RAISE NOTICE '=====================================';
  RAISE NOTICE ' TOUS LES CONTROLES RLS PASSENT';
  RAISE NOTICE '=====================================';
END $$;

ROLLBACK;
