-- ============================================================
-- Tests de refresh_scores()
--
-- Vérifie la formule de score du §4.3 de AUDIT-FIABILITE-SCORES.md sur des
-- jeux d'essai dont les valeurs attendues sont calculables à la main.
--
-- Exécution (base locale, après application des migrations) :
--   npx supabase db reset            # applique toutes les migrations
--   psql "$DATABASE_URL" -f supabase/tests/test_refresh_scores.sql
--
-- Le script tourne dans une transaction annulée à la fin : il n'écrit rien
-- durablement. Il attend une base SANS données réelles (les assertions de
-- présence et de couverture comptent l'ensemble des scrutins solennels).
--
-- Sortie : une ligne "OK" par test, ou une exception au premier écart.
-- ============================================================

BEGIN;

-- ─── Utilitaires d'assertion ────────────────────────────────────────────────

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

-- ─── Jeu d'essai ────────────────────────────────────────────────────────────

INSERT INTO dim_groupe (id, uid_officiel, sigle, nom_complet, couleur_hex, nb_sieges)
VALUES (900, 'PO900', 'TESTA', 'Groupe de test A', '#111111', 10),
       (901, 'PO901', 'TESTB', 'Groupe de test B', '#222222', 10);

INSERT INTO dim_theme (id, slug, label, emoji, ordre)
VALUES (900, 'test-theme', 'Thème de test', '🧪', 99);

INSERT INTO dim_depute (id, uid_an, nom, prenom, groupe_id, departement, num_circo)
SELECT 9000 + i, 'PA90' || i, 'Nom' || i, 'Prenom' || i,
       CASE WHEN i = 10 THEN 901 ELSE 900 END, 'Testville', i
FROM generate_series(1, 10) AS i;

-- Promesses canoniques du groupe 900.
-- 9003 ne sera jamais classifiée : elle sert à tester la couverture.
INSERT INTO dim_promesse (
  id, groupe_id, theme_id, intitule_court, source_pdf_nom, source_pdf_page,
  source_citation, dedupe_hash, statut, canonical_id, est_canonique
)
VALUES
  (9001, 900, 900, 'Promesse test 1', 'test.pdf', 1, 'citation 1', repeat('a', 64), 'valide', 9001, true),
  (9002, 900, 900, 'Promesse test 2', 'test.pdf', 2, 'citation 2', repeat('b', 64), 'valide', 9002, true),
  (9003, 900, 900, 'Promesse test 3', 'test.pdf', 3, 'citation 3', repeat('c', 64), 'valide', 9003, true);

INSERT INTO promesse_groupe (promesse_id, groupe_id, type_engagement)
VALUES (9001, 900, 'programme_propre'),
       (9002, 900, 'programme_propre'),
       (9003, 900, 'programme_propre');

-- 12 scrutins ordinaires (poids 1), 1 solennel (poids 3),
-- 1 motion de censure (poids 0), 1 scrutin dont la classification reste brouillon.
INSERT INTO fact_scrutin (
  id, uid_an, numero, legislature, titre, objet, date_scrutin, sort_adopte,
  categorie, type_vote, eligible, llm_traite
)
SELECT 9100 + i, 'VTTEST' || i, 9100 + i, 17, 'titre ' || i, 'objet ' || i,
       DATE '2025-01-01' + i, true, 'autre', 'SPO', true, true
FROM generate_series(1, 12) AS i;

INSERT INTO fact_scrutin (
  id, uid_an, numero, legislature, titre, objet, date_scrutin, sort_adopte,
  categorie, type_vote, eligible, llm_traite
)
VALUES
  (9201, 'VTTESTSOL', 9201, 17, 'solennel',  'objet solennel', DATE '2025-06-01', true, 'solennel',       'SPS', true, true),
  (9202, 'VTTESTMOC', 9202, 17, 'censure',   'objet censure',  DATE '2025-06-02', false,'motion_censure', 'MOC', true, true),
  (9203, 'VTTESTBRO', 9203, 17, 'brouillon', 'objet brouillon',DATE '2025-06-03', true, 'autre',          'SPO', true, true),
  -- Scrutin dédié à l'agrégation intra-scrutin : lié à DEUX promesses de
  -- polarités opposées. Aucun autre député n'y vote, pour ne pas polluer
  -- les autres cas de test.
  (9204, 'VTTESTDBL', 9204, 17, 'double',    'objet double',   DATE '2025-06-04', true, 'autre',          'SPO', true, true);

-- Classifications publiées : polarité +1 sur la promesse 9001
INSERT INTO llm_classification (
  scrutin_id, promesse_id, polarite_llm, confidence_score, statut_validation,
  statut_publication, modele_llm, prompt_hash
)
SELECT 9100 + i, 9001, 1, 0.95, 'valide', 'publie', 'test', repeat('h', 64)
FROM generate_series(1, 12) AS i;

INSERT INTO llm_classification (
  scrutin_id, promesse_id, polarite_llm, confidence_score, statut_validation,
  statut_publication, modele_llm, prompt_hash
)
VALUES
  -- Scrutin 9204 lié à DEUX promesses de polarités opposées : teste l'étape 2
  -- (moyenne intra-scrutin), qui empêche un scrutin lié à N promesses de peser N fois.
  (9204, 9001,  1, 0.9, 'valide', 'publie', 'test', repeat('h', 64)),
  (9204, 9002, -1, 0.9, 'valide', 'publie', 'test', repeat('h', 64)),
  (9201, 9001,  1, 0.9, 'valide', 'publie', 'test', repeat('h', 64)),
  (9202, 9001,  1, 0.9, 'valide', 'publie', 'test', repeat('h', 64)),
  -- Classification NON publiée : ne doit jamais entrer dans le score.
  (9203, 9001,  1, 0.9, 'auto',  'brouillon', 'test', repeat('h', 64));

-- ── Votes ──
-- d9001 : POUR partout          → cohérence maximale
-- d9002 : CONTRE partout        → opposition totale
-- d9003 : abstention partout    → poids 0,5 ⇒ n_eff insuffisant
-- d9004 : 6 POUR puis 6 CONTRE  → score neutre
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
SELECT 9001, 9100 + i, 900,  1 FROM generate_series(1, 12) AS i;
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
SELECT 9002, 9100 + i, 900, -1 FROM generate_series(1, 12) AS i;
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
SELECT 9003, 9100 + i, 900,  0 FROM generate_series(1, 12) AS i;
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
SELECT 9004, 9100 + i, 900, CASE WHEN i <= 6 THEN 1 ELSE -1 END FROM generate_series(1, 12) AS i;

-- d9005 : un seul vote, sur le scrutin lié à DEUX promesses de polarités opposées
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
VALUES (9005, 9204, 900, 1);

-- d9006 : un seul vote, sur le scrutin SOLENNEL (poids 3), non délégué
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote, par_delegation)
VALUES (9006, 9201, 900, 1, false);

-- d9007 : un seul vote, sur la MOTION DE CENSURE (poids 0) → exclu du score
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
VALUES (9007, 9202, 900, 1);

-- d9008 : vote consigné CONTRE, rectifié en POUR par mise au point
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote, position_vote_corrigee)
VALUES (9008, 9102, 900, -1, 1);

-- d9009 : ne vote que sur le scrutin dont la classification est en brouillon
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
VALUES (9009, 9203, 900, 1);

-- d9010 : rattaché au groupe 901 aujourd'hui, mais appartenait au groupe 900
-- au moment du vote → doit être évalué sur les promesses du groupe 900
INSERT INTO fact_vote_individuel (depute_id, scrutin_id, groupe_id_au_moment_du_vote, position_vote)
VALUES (9010, 9103, 900, 1);

-- ─── Calcul ─────────────────────────────────────────────────────────────────

SELECT * FROM refresh_scores();

-- ─── Assertions ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_score      smallint;
  v_brut       numeric;
  v_neff       numeric;
  v_pub        boolean;
  v_label      varchar;
  v_avant      smallint;
  v_taux       numeric;
  v_n          int;
BEGIN
  -- ══ Score de groupe ══
  -- Σw = 12(d1) + 12(d2) + 6(d3) + 12(d4) = 42 ; Σw·A = 12 − 12 + 0 + 0 = 0
  -- (d5..d10 ajoutent quelques lignes : on vérifie l'ordre de grandeur et le brut)
  SELECT score_brut, n_eff, publiable, label_meteo
    INTO v_brut, v_neff, v_pub, v_label
  FROM cache_score_groupe WHERE groupe_id = 900 AND theme_id IS NULL;

  PERFORM pg_temp.assert_eq('Groupe 900 publiable (n_eff >= 30)', v_pub, true);
  PERFORM pg_temp.assert_eq('Groupe 900 météo = nuage (score ~50)', v_label, 'nuage'::varchar);

  -- ══ d9001 : cohérence maximale, mais rétrécie vers le groupe ══
  -- brut = 1 → 100 ; shrinkage = (12×1 + 8×score_groupe)/(12+8)
  SELECT score_0_100, score_avant_shrinkage, n_eff, publiable, label_meteo
    INTO v_score, v_avant, v_neff, v_pub, v_label
  FROM cache_score_depute WHERE depute_id = 9001 AND theme_id IS NULL;

  PERFORM pg_temp.assert_eq('d9001 score avant shrinkage = 100', v_avant, 100::smallint);
  PERFORM pg_temp.assert_eq('d9001 n_eff = 12', v_neff, 12.00::numeric);
  PERFORM pg_temp.assert_eq('d9001 publiable', v_pub, true);
  IF v_score >= v_avant THEN
    RAISE EXCEPTION 'ECHEC — d9001 : le shrinkage doit abaisser 100 vers le groupe (obtenu %)', v_score;
  END IF;
  RAISE NOTICE 'OK   — d9001 shrinkage 100 -> %', v_score;

  -- ══ d9002 : opposition totale ══
  SELECT score_avant_shrinkage, n_eff INTO v_avant, v_neff
  FROM cache_score_depute WHERE depute_id = 9002 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9002 score avant shrinkage = 0', v_avant, 0::smallint);
  PERFORM pg_temp.assert_eq('d9002 n_eff = 12', v_neff, 12.00::numeric);

  -- ══ d9003 : abstention à demi-poids ══
  -- 12 abstentions × 0,5 = 6 < seuil 10 → non publiable, brouillard
  SELECT n_eff, publiable, label_meteo, taux_abstention
    INTO v_neff, v_pub, v_label, v_taux
  FROM cache_score_depute WHERE depute_id = 9003 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9003 n_eff = 6 (12 abstentions x 0,5)', v_neff, 6.00::numeric);
  PERFORM pg_temp.assert_eq('d9003 non publiable (6 < 10)', v_pub, false);
  PERFORM pg_temp.assert_eq('d9003 météo = brouillard', v_label, 'brouillard'::varchar);
  PERFORM pg_temp.assert_eq('d9003 taux abstention = 1', v_taux, 1.0000::numeric);

  -- ══ d9004 : neutre ══
  SELECT score_avant_shrinkage, publiable INTO v_avant, v_pub
  FROM cache_score_depute WHERE depute_id = 9004 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9004 score avant shrinkage = 50', v_avant, 50::smallint);
  PERFORM pg_temp.assert_eq('d9004 publiable (n_eff = 12)', v_pub, true);

  -- ══ d9005 : agrégation intra-scrutin ══
  -- Un scrutin lié à 2 promesses de polarités opposées ⇒ A = 0 et n_eff = 1,
  -- et non deux lignes de poids 1 chacune.
  SELECT score_avant_shrinkage, n_eff, nb_scrutins INTO v_avant, v_neff, v_n
  FROM cache_score_depute WHERE depute_id = 9005 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9005 A = 0 (polarités opposées)', v_avant, 50::smallint);
  PERFORM pg_temp.assert_eq('d9005 n_eff = 1 (un seul scrutin, pas deux)', v_neff, 1.00::numeric);
  PERFORM pg_temp.assert_eq('d9005 nb_scrutins = 1', v_n, 1);

  -- ══ d9006 : pondération du scrutin solennel ══
  SELECT n_eff, taux_presence INTO v_neff, v_taux
  FROM cache_score_depute WHERE depute_id = 9006 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9006 n_eff = 3 (solennel pondéré x3)', v_neff, 3.00::numeric);
  PERFORM pg_temp.assert_eq('d9006 présence = 1 (seul solennel, vote personnel)', v_taux, 1.0000::numeric);

  -- ══ d9007 : motion de censure exclue ══
  -- Seuls les votes POUR y sont enregistrés : les non-votants ne sont pas des
  -- opposants. Poids 0 ⇒ aucune ligne de score.
  SELECT COUNT(*) INTO v_n FROM cache_score_depute WHERE depute_id = 9007;
  PERFORM pg_temp.assert_eq('d9007 aucune ligne (motion de censure exclue)', v_n, 0);

  -- ══ d9008 : mise au point appliquée ══
  -- Vote consigné CONTRE, rectifié POUR ⇒ alignement +1, donc score 100.
  SELECT score_avant_shrinkage INTO v_avant
  FROM cache_score_depute WHERE depute_id = 9008 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9008 mise au point appliquée (score 100)', v_avant, 100::smallint);

  -- ══ d9009 : classification en brouillon ignorée ══
  SELECT COUNT(*) INTO v_n FROM cache_score_depute WHERE depute_id = 9009;
  PERFORM pg_temp.assert_eq('d9009 aucune ligne (classification brouillon)', v_n, 0);

  -- ══ d9010 : promesses du groupe À LA DATE DU VOTE ══
  -- Rattaché au groupe 901 aujourd'hui, mais a voté sous le groupe 900 :
  -- il doit être évalué sur les promesses du groupe 900.
  SELECT COUNT(*) INTO v_n FROM cache_score_depute WHERE depute_id = 9010 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9010 évalué sur le groupe du moment du vote', v_n, 1);

  -- ══ Présence : d9001 absent du seul scrutin solennel ══
  SELECT taux_presence INTO v_taux
  FROM cache_score_depute WHERE depute_id = 9001 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('d9001 présence = 0 (absent du solennel)', v_taux, 0.0000::numeric);

  -- ══ Couverture : 2 promesses testées sur 3 ══
  SELECT nb_promesses_testees, nb_promesses_total, taux_couverture
    INTO v_n, v_score, v_taux
  FROM cache_score_groupe WHERE groupe_id = 900 AND theme_id IS NULL;
  PERFORM pg_temp.assert_eq('Couverture : 2 promesses testées', v_n, 2);
  PERFORM pg_temp.assert_eq('Couverture : 3 promesses au total', v_score, 3::smallint);
  PERFORM pg_temp.assert_eq('Taux de couverture = 2/3', ROUND(v_taux, 4), 0.6667::numeric);

  -- ══ Score par thème ══
  SELECT COUNT(*) INTO v_n
  FROM cache_score_depute WHERE depute_id = 9001 AND theme_id = 900;
  PERFORM pg_temp.assert_eq('d9001 a bien un score sur le thème 900', v_n, 1);

  -- ══ Intervalle de confiance ══
  SELECT score_ic_bas, score_ic_haut INTO v_score, v_avant
  FROM cache_score_depute WHERE depute_id = 9004 AND theme_id IS NULL;
  IF v_score >= v_avant THEN
    RAISE EXCEPTION 'ECHEC — IC : borne basse % >= borne haute %', v_score, v_avant;
  END IF;
  RAISE NOTICE 'OK   — d9004 IC 95%% = [%, %]', v_score, v_avant;

  -- Régression : un député dont TOUS les votes sont alignés a une variance
  -- d'échantillon nulle. Avec une erreur-type classique, son IC serait de
  -- largeur zéro — la surconfiance exacte que l'intervalle doit empêcher.
  -- L'intervalle de Wilson reste correct aux bornes.
  SELECT score_ic_bas, score_ic_haut INTO v_score, v_avant
  FROM cache_score_depute WHERE depute_id = 9001 AND theme_id IS NULL;
  IF v_avant - v_score < 5 THEN
    RAISE EXCEPTION
      'ECHEC — d9001 (12 votes identiques) : IC dégénéré [%, %], largeur %',
      v_score, v_avant, v_avant - v_score;
  END IF;
  RAISE NOTICE 'OK   — d9001 IC non dégénéré malgré 12 votes identiques = [%, %]', v_score, v_avant;

  -- L'IC doit se resserrer quand l'échantillon grandit.
  SELECT (score_ic_haut - score_ic_bas) INTO v_n
  FROM cache_score_depute WHERE depute_id = 9005 AND theme_id IS NULL;  -- n_eff = 1
  SELECT (score_ic_haut - score_ic_bas) INTO v_score
  FROM cache_score_depute WHERE depute_id = 9004 AND theme_id IS NULL;  -- n_eff = 12
  IF v_score >= v_n THEN
    RAISE EXCEPTION 'ECHEC — IC : n_eff=12 (largeur %) devrait être plus étroit que n_eff=1 (largeur %)',
      v_score, v_n;
  END IF;
  RAISE NOTICE 'OK   — IC se resserre avec l''échantillon : % (n=1) -> % (n=12)', v_n, v_score;

  RAISE NOTICE '';
  RAISE NOTICE '===================================';
  RAISE NOTICE ' TOUS LES TESTS DE SCORE PASSENT';
  RAISE NOTICE '===================================';
END;
$$;

-- ─── Étiquettes météo aux bornes ────────────────────────────────────────────

DO $$
BEGIN
  PERFORM pg_temp.assert_eq('meteo(100) = soleil',     label_meteo(100::smallint, true), 'soleil'::varchar);
  PERFORM pg_temp.assert_eq('meteo(81)  = soleil',     label_meteo(81::smallint,  true), 'soleil'::varchar);
  PERFORM pg_temp.assert_eq('meteo(80)  = eclaircies', label_meteo(80::smallint,  true), 'eclaircies'::varchar);
  PERFORM pg_temp.assert_eq('meteo(61)  = eclaircies', label_meteo(61::smallint,  true), 'eclaircies'::varchar);
  PERFORM pg_temp.assert_eq('meteo(60)  = nuage',      label_meteo(60::smallint,  true), 'nuage'::varchar);
  PERFORM pg_temp.assert_eq('meteo(31)  = nuage',      label_meteo(31::smallint,  true), 'nuage'::varchar);
  PERFORM pg_temp.assert_eq('meteo(30)  = orage',      label_meteo(30::smallint,  true), 'orage'::varchar);
  PERFORM pg_temp.assert_eq('meteo(0)   = orage',      label_meteo(0::smallint,   true), 'orage'::varchar);
  PERFORM pg_temp.assert_eq('meteo non publiable = brouillard', label_meteo(95::smallint, false), 'brouillard'::varchar);
  PERFORM pg_temp.assert_eq('meteo(NULL) = brouillard', label_meteo(NULL::smallint, true), 'brouillard'::varchar);
END;
$$;

-- ─── Analyse de sensibilité (§5.5) ──────────────────────────────────────────
-- Le classement météo des groupes ne doit pas basculer quand on fait varier
-- les choix éditoriaux. Ici on vérifie seulement que la fonction accepte les
-- variantes ; la comparaison des classements se fait sur données réelles.

SELECT 'sensibilite: abstention ignoree' AS variante, * FROM refresh_scores(p_poids_abstention => 0);
SELECT 'sensibilite: abstention pleine'  AS variante, * FROM refresh_scores(p_poids_abstention => 1);
SELECT 'sensibilite: shrinkage faible'   AS variante, * FROM refresh_scores(p_k_shrinkage => 5);
SELECT 'sensibilite: shrinkage fort'     AS variante, * FROM refresh_scores(p_k_shrinkage => 15);

-- Recalcul final avec les paramètres de référence : le cache ne doit pas rester
-- dans l'état d'une variante de test.
SELECT * FROM refresh_scores();

ROLLBACK;
