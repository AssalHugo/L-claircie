-- ============================================================
-- Sprint 3 — Calcul des scores
--
-- Implémente la formule du §4.3 de AUDIT-FIABILITE-SCORES.md :
--   1. alignement élémentaire   a(s,p) = vote × polarité
--   2. agrégation intra-scrutin A(d,s) = moyenne des a sur les promesses liées
--   3. pondération              w(s)   = w_type × w_abstention
--   4. score brut               Σ w·A / Σ w  ∈ [-1, 1]
--   5. rétrécissement bayésien  vers le score du groupe
--   6. seuil de publication     sous n_eff minimal → 🌫️ Brouillard
--   7. intervalle de confiance  à 95 %
--
-- Et les TROIS indicateurs séparés du §4.1 : Cohérence, Présence, Couverture.
--
-- Le calcul vit en SQL et non en TypeScript : n'importe qui ayant accès au
-- schéma peut le relire et refaire le calcul. C'est un argument de neutralité
-- autant qu'un choix technique.
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Colonnes de restitution des scores
-- ────────────────────────────────────────────────────────────

ALTER TABLE "cache_score_groupe"
  ADD COLUMN IF NOT EXISTS "n_eff"                 numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "score_ic_bas"          smallint,
  ADD COLUMN IF NOT EXISTS "score_ic_haut"         smallint,
  ADD COLUMN IF NOT EXISTS "publiable"             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "taux_abstention"       numeric(5,4),
  ADD COLUMN IF NOT EXISTS "taux_presence"         numeric(5,4),
  ADD COLUMN IF NOT EXISTS "taux_couverture"       numeric(5,4),
  ADD COLUMN IF NOT EXISTS "nb_promesses_testees"  int,
  ADD COLUMN IF NOT EXISTS "nb_promesses_total"    int;

ALTER TABLE "cache_score_depute"
  ADD COLUMN IF NOT EXISTS "label_meteo"           varchar(20) NOT NULL DEFAULT 'brouillard',
  ADD COLUMN IF NOT EXISTS "n_eff"                 numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "score_ic_bas"          smallint,
  ADD COLUMN IF NOT EXISTS "score_ic_haut"         smallint,
  ADD COLUMN IF NOT EXISTS "publiable"             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "taux_abstention"       numeric(5,4),
  ADD COLUMN IF NOT EXISTS "taux_presence"         numeric(5,4),
  ADD COLUMN IF NOT EXISTS "score_avant_shrinkage" smallint;

COMMENT ON COLUMN "cache_score_groupe"."n_eff" IS
  'Somme des poids Σw. Sert de taille d''échantillon effective : c''est elle, et non le nombre '
  'brut de scrutins, qui conditionne la publication et la largeur de l''intervalle de confiance.';
COMMENT ON COLUMN "cache_score_groupe"."publiable" IS
  'false = n_eff sous le seuil minimal. La météo affichée doit alors être 🌫️ Brouillard '
  '("Données insuffisantes"), jamais un chiffre : sous n_eff = 10, l''IC 95 % dépasse '
  'la largeur d''une catégorie météo entière.';
COMMENT ON COLUMN "cache_score_groupe"."taux_abstention" IS
  'Part des scrutins retenus où le groupe s''est abstenu SUR SES PROPRES ENGAGEMENTS. '
  'Publié séparément : l''abstention est la façon la plus courante d''esquiver un engagement '
  'sans trahison visible, elle ne doit pas être dissoute dans le score composite.';
COMMENT ON COLUMN "cache_score_groupe"."taux_presence" IS
  'Part des scrutins SOLENNELS où les membres ont exprimé un vote non délégué. '
  'Restreint aux solennels : la participation médiane y est de 92 %, contre 26 % sur les '
  'scrutins ordinaires où l''absence est la norme et donc ininterprétable.';
COMMENT ON COLUMN "cache_score_groupe"."taux_couverture" IS
  'Part des promesses du groupe effectivement mises à l''épreuve par au moins un scrutin. '
  'Indispensable à la neutralité : l''ordre du jour étant fixé par le gouvernement, QUELLES '
  'promesses sont testées n''a rien d''aléatoire. Un groupe d''opposition couvert à 8 % '
  'n''est pas comparable à un groupe de la majorité couvert à 40 %.';
COMMENT ON COLUMN "cache_score_depute"."score_avant_shrinkage" IS
  'Score du député avant rétrécissement vers son groupe. Conservé pour transparence : '
  'le Mode Expert doit pouvoir montrer l''effet du lissage.';
COMMENT ON COLUMN "cache_score_depute"."taux_presence" IS
  'Calculé sur les scrutins solennels postérieurs à l''entrée en fonction du député, '
  'hors votes par délégation (15 % des votes : un député "présent" dans les données '
  'peut être physiquement absent).';

-- Les index UNIQUE d'origine ne protègent rien quand theme_id est NULL
-- (en SQL, deux NULL sont distincts). On les remplace par des index partiels.
DROP INDEX IF EXISTS "uq_score_groupe_theme";
DROP INDEX IF EXISTS "uq_score_depute_theme";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_score_groupe_theme"
  ON "cache_score_groupe" ("groupe_id", "theme_id") WHERE "theme_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_score_groupe_global"
  ON "cache_score_groupe" ("groupe_id") WHERE "theme_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_score_depute_theme"
  ON "cache_score_depute" ("depute_id", "theme_id") WHERE "theme_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_score_depute_global"
  ON "cache_score_depute" ("depute_id") WHERE "theme_id" IS NULL;

-- ────────────────────────────────────────────────────────────
-- 2. Étiquette météo
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "label_meteo"(
  p_score smallint,
  p_publiable boolean
) RETURNS varchar
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NOT p_publiable OR p_score IS NULL THEN 'brouillard'  -- 🌫️ Données insuffisantes
    WHEN p_score >= 81 THEN 'soleil'                            -- ☀️
    WHEN p_score >= 61 THEN 'eclaircies'                        -- 🌤️
    WHEN p_score >= 31 THEN 'nuage'                             -- ☁️
    ELSE 'orage'                                                -- ⛈️
  END;
$$;

COMMENT ON FUNCTION "label_meteo" IS
  'Seuils météo : 0-30 orage, 31-60 nuage, 61-80 éclaircies, 81-100 soleil. '
  'La 5e catégorie ''brouillard'' couvre le cas où l''échantillon est trop faible '
  'pour qu''un chiffre ait une valeur informative.';

-- ────────────────────────────────────────────────────────────
-- 2 bis. Intervalle de confiance à 95 % — méthode de Wilson
--
-- Le score n'est rien d'autre qu'un TAUX D'ALIGNEMENT : p = (score_brut + 1)/2,
-- soit exactement score_0_100/100. L'intervalle de Wilson est la méthode
-- standard pour une proportion, et surtout la seule correcte aux bornes.
--
-- Pourquoi pas l'erreur-type de la moyenne pondérée : un député dont les 12
-- votes sont tous alignés a une variance d'échantillon NULLE, donc un IC de
-- largeur zéro — précisément la surconfiance que l'intervalle devait empêcher.
-- Wilson donne ici [76, 100] au lieu de [100, 100].
--
-- Écart assumé avec le §4.3 de l'audit, qui évoquait un bootstrap : Wilson est
-- calculable en SQL pur, déterministe, et plus juste sur petits échantillons.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "score_intervalle"(
  p_score_brut numeric,   -- dans [-1, 1]
  p_n          numeric    -- taille d'échantillon effective
) RETURNS int[]
LANGUAGE sql IMMUTABLE AS $$
  WITH "params" AS (
    SELECT 1.96::numeric               AS "z",
           GREATEST(p_n, 1e-6)         AS "n",
           LEAST(GREATEST((p_score_brut + 1) / 2, 0), 1) AS "p"
  ), "calc" AS (
    SELECT "z", "n", "p",
           1 + "z" ^ 2 / "n"                                   AS "denom",
           ("p" + "z" ^ 2 / (2 * "n"))                          AS "num_centre",
           sqrt("p" * (1 - "p") / "n" + "z" ^ 2 / (4 * "n" ^ 2)) AS "racine"
    FROM "params"
  )
  SELECT ARRAY[
    GREATEST(0,   ROUND(100 * ("num_centre" / "denom" - ("z" / "denom") * "racine")))::int,
    LEAST(100,    ROUND(100 * ("num_centre" / "denom" + ("z" / "denom") * "racine")))::int
  ]
  FROM "calc";
$$;

COMMENT ON FUNCTION "score_intervalle" IS
  'Intervalle de Wilson à 95 % sur le taux d''alignement, restitué sur l''échelle 0-100. '
  'Si l''intervalle chevauche deux catégories météo, l''UI doit afficher la catégorie basse '
  'et signaler l''incertitude.';

-- ────────────────────────────────────────────────────────────
-- 3. Vue de base : alignement élémentaire
--
-- Un vote ne compte QUE contre les promesses portées par le groupe auquel
-- le député appartenait À LA DATE DU VOTE.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW "v_alignement" AS
SELECT
  v."depute_id",
  v."scrutin_id",
  v."groupe_id_au_moment_du_vote"                     AS "groupe_id",
  p."theme_id",
  c."promesse_id",
  s."categorie",
  -- Une mise au point rectifie la position affichée sans changer le résultat
  -- officiel du scrutin : le score doit refléter la position rectifiée.
  COALESCE(v."position_vote_corrigee", v."position_vote") AS "position",
  COALESCE(v."position_vote_corrigee", v."position_vote") * c."polarite_llm" AS "a"
FROM "fact_vote_individuel" v
JOIN "fact_scrutin"        s  ON s."id" = v."scrutin_id"
JOIN "llm_classification"  c  ON c."scrutin_id" = v."scrutin_id"
JOIN "dim_promesse"        p  ON p."id" = c."promesse_id"
JOIN "promesse_groupe"     pg ON pg."promesse_id" = p."id"
                             AND pg."groupe_id"   = v."groupe_id_au_moment_du_vote"
WHERE s."eligible" = true
  -- Seules les classifications validées par un humain entrent dans le score.
  AND c."statut_publication" = 'publie'
  AND p."est_canonique" = true
  AND p."statut" IN ('auto', 'valide', 'active')
  -- Absent / non-votant : aucune position exprimée, donc hors cohérence.
  AND COALESCE(v."position_vote_corrigee", v."position_vote") IS NOT NULL;

COMMENT ON VIEW "v_alignement" IS
  'Alignement élémentaire a = position × polarité, pour chaque couple '
  '(député, scrutin, promesse) éligible et publié. Base de tous les scores.';

-- ────────────────────────────────────────────────────────────
-- 4. refresh_scores() — recalcul complet des caches
--
-- Les paramètres sont exposés pour permettre l'analyse de sensibilité
-- exigée au §5 de l'audit : si le classement météo des groupes bascule
-- quand on fait varier ces valeurs, le score est trop fragile pour être publié.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "refresh_scores"(
  p_k_shrinkage      numeric DEFAULT 8,     -- force du rétrécissement vers le groupe
  p_seuil_depute     numeric DEFAULT 10,    -- n_eff minimal pour publier un score député
  p_seuil_groupe     numeric DEFAULT 30,    -- n_eff minimal pour publier un score groupe
  p_poids_abstention numeric DEFAULT 0.5,   -- §7.1 : abstention neutre à demi-poids
  p_poids_solennel   numeric DEFAULT 3,
  p_poids_ensemble   numeric DEFAULT 2,
  p_poids_censure    numeric DEFAULT 0      -- §4.4 : seuls les votes POUR sont enregistrés
) RETURNS TABLE (
  "niveau"      text,
  "lignes"      bigint,
  "publiables"  bigint
)
LANGUAGE plpgsql AS $$
DECLARE
  v_legislature_debut CONSTANT date := DATE '2024-07-18';
BEGIN
  -- `ON COMMIT DROP` ne libère les tables temporaires qu'au commit : sans ces
  -- suppressions explicites, deux appels dans une même transaction échouent.
  -- C'est précisément ce que fait l'analyse de sensibilité du §5.
  DROP TABLE IF EXISTS "tmp_scrutin_agg";
  DROP TABLE IF EXISTS "tmp_score_groupe";
  DROP TABLE IF EXISTS "tmp_score_depute";
  DROP TABLE IF EXISTS "tmp_presence";
  DROP TABLE IF EXISTS "tmp_couverture";

  -- ══ Étapes 1 à 3 : alignement, agrégation intra-scrutin, pondération ══
  CREATE TEMP TABLE "tmp_scrutin_agg" ON COMMIT DROP AS
  SELECT
    al."depute_id",
    al."scrutin_id",
    al."groupe_id",
    al."theme_id",
    al."position",
    -- Étape 2 : moyenne des alignements sur les promesses liées au scrutin.
    -- Sans cela, un scrutin rattaché à 12 promesses pèserait 12 fois plus
    -- qu'un scrutin rattaché à une seule : une loi de finances écraserait tout.
    AVG(al."a"::numeric) AS "A",
    -- Étape 3 : poids du scrutin
    (CASE al."categorie"
       WHEN 'solennel'       THEN p_poids_solennel
       WHEN 'ensemble_texte' THEN p_poids_ensemble
       WHEN 'motion_censure' THEN p_poids_censure
       ELSE 1
     END)
    * (CASE WHEN al."position" = 0 THEN p_poids_abstention ELSE 1 END) AS "w"
  FROM "v_alignement" al
  GROUP BY GROUPING SETS (
    (al."depute_id", al."scrutin_id", al."groupe_id", al."categorie", al."position", al."theme_id"),
    (al."depute_id", al."scrutin_id", al."groupe_id", al."categorie", al."position")
  );
  -- theme_id NULL = score global toutes thématiques (issu du GROUPING SET court)

  DELETE FROM "tmp_scrutin_agg" WHERE "w" = 0;  -- motions de censure exclues

  -- ══ Scores de GROUPE (calculés d'abord : ils servent de prior au shrinkage) ══
  CREATE TEMP TABLE "tmp_score_groupe" ON COMMIT DROP AS
  SELECT
    "groupe_id",
    "theme_id",
    SUM("w")                                        AS "n_eff",
    COUNT(*)                                        AS "nb_scrutins",
    SUM("w" * "A") / NULLIF(SUM("w"), 0)            AS "score_brut",
    SUM(CASE WHEN "position" = 0 THEN 1 ELSE 0 END)::numeric
      / NULLIF(COUNT(*), 0)                         AS "taux_abstention"
  FROM "tmp_scrutin_agg"
  GROUP BY "groupe_id", "theme_id";

  -- ══ Scores de DÉPUTÉ ══
  CREATE TEMP TABLE "tmp_score_depute" ON COMMIT DROP AS
  WITH "brut" AS (
    SELECT
      "depute_id",
      "theme_id",
      -- Groupe le plus fréquent du député sur la période : sert de prior au
      -- rétrécissement. Un transfuge est lissé vers le groupe sous lequel il a
      -- effectivement le plus voté, pas vers son groupe d'arrivée.
      (SELECT t2."groupe_id" FROM "tmp_scrutin_agg" t2
        WHERE t2."depute_id" = t."depute_id"
          AND t2."theme_id" IS NOT DISTINCT FROM t."theme_id"
        GROUP BY t2."groupe_id" ORDER BY SUM(t2."w") DESC, t2."groupe_id" LIMIT 1
      )                                               AS "groupe_id",
      SUM("w")                                        AS "n_eff",
      COUNT(*)                                        AS "nb_scrutins",
      SUM("w" * "A") / NULLIF(SUM("w"), 0)            AS "score_brut",
      SUM(CASE WHEN "position" = 0 THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0)                         AS "taux_abstention"
    FROM "tmp_scrutin_agg" t
    GROUP BY "depute_id", "theme_id"
  )
  SELECT
    b.*,
    -- Étape 5 : rétrécissement bayésien vers le score du groupe.
    -- Tant qu'on a peu de votes, on part de la position du groupe.
    CASE
      WHEN g."score_brut" IS NULL THEN b."score_brut"
      ELSE (b."n_eff" * b."score_brut" + p_k_shrinkage * g."score_brut")
           / (b."n_eff" + p_k_shrinkage)
    END AS "score_shrunk"
  FROM "brut" b
  LEFT JOIN "tmp_score_groupe" g
    ON g."groupe_id" = b."groupe_id"
   AND g."theme_id" IS NOT DISTINCT FROM b."theme_id";

  -- ══ Présence — uniquement sur les scrutins SOLENNELS ══
  CREATE TEMP TABLE "tmp_presence" ON COMMIT DROP AS
  WITH "entree" AS (
    SELECT d."id" AS "depute_id",
           COALESCE(MIN(h."date_debut"), v_legislature_debut) AS "date_entree"
    FROM "dim_depute" d
    LEFT JOIN "dim_depute_groupe_historique" h ON h."depute_id" = d."id"
    GROUP BY d."id"
  ),
  "solennels" AS (
    SELECT "id", "date_scrutin" FROM "fact_scrutin"
    WHERE "eligible" = true AND "categorie" = 'solennel'
  ),
  "attendus" AS (
    -- Dénominateur : les scrutins solennels postérieurs à l'entrée en fonction.
    SELECT e."depute_id", COUNT(s."id") AS "nb_attendus"
    FROM "entree" e
    LEFT JOIN "solennels" s ON s."date_scrutin" >= e."date_entree"
    GROUP BY e."depute_id"
  ),
  "presents" AS (
    -- Numérateur : vote personnellement exprimé. Le vote par délégation ne
    -- vaut pas présence (15 % des votes sont émis par procuration).
    SELECT v."depute_id", COUNT(DISTINCT v."scrutin_id") AS "nb_presents"
    FROM "fact_vote_individuel" v
    JOIN "solennels" s ON s."id" = v."scrutin_id"
    WHERE COALESCE(v."position_vote_corrigee", v."position_vote") IS NOT NULL
      AND v."par_delegation" = false
    GROUP BY v."depute_id"
  )
  SELECT
    a."depute_id",
    a."nb_attendus",
    COALESCE(p."nb_presents", 0) AS "nb_presents",
    CASE WHEN a."nb_attendus" > 0
         THEN COALESCE(p."nb_presents", 0)::numeric / a."nb_attendus"
         END AS "taux_presence"
  FROM "attendus" a
  LEFT JOIN "presents" p ON p."depute_id" = a."depute_id";

  -- ══ Couverture — part des promesses du groupe réellement mises à l'épreuve ══
  CREATE TEMP TABLE "tmp_couverture" ON COMMIT DROP AS
  WITH "promesses_groupe" AS (
    SELECT pg."groupe_id", p."id" AS "promesse_id", p."theme_id"
    FROM "promesse_groupe" pg
    JOIN "dim_promesse" p ON p."id" = pg."promesse_id"
    WHERE p."est_canonique" = true
      AND p."statut" IN ('auto', 'valide', 'active')
  ),
  "testees" AS (
    SELECT DISTINCT c."promesse_id"
    FROM "llm_classification" c
    JOIN "fact_scrutin" s ON s."id" = c."scrutin_id"
    WHERE c."statut_publication" = 'publie' AND s."eligible" = true
  )
  SELECT
    pgr."groupe_id",
    pgr."theme_id",
    COUNT(*)                                                       AS "nb_total",
    COUNT(t."promesse_id")                                         AS "nb_testees",
    COUNT(t."promesse_id")::numeric / NULLIF(COUNT(*), 0)          AS "taux_couverture"
  FROM "promesses_groupe" pgr
  LEFT JOIN "testees" t ON t."promesse_id" = pgr."promesse_id"
  GROUP BY GROUPING SETS ((pgr."groupe_id", pgr."theme_id"), (pgr."groupe_id"));

  -- ══ Écriture des caches (reconstruction complète : donnée dérivée) ══
  -- WHERE true obligatoire : Supabase active pg_safeupdate sur les connexions
  -- PostgREST, qui rejette tout DELETE sans clause WHERE. Sans cela, l appel
  -- via supabase.rpc("refresh_scores") echoue avec le code 21000.
  DELETE FROM "cache_score_groupe" WHERE true;
  INSERT INTO "cache_score_groupe" (
    "groupe_id", "theme_id", "score_0_100", "score_brut", "nb_scrutins", "label_meteo",
    "n_eff", "score_ic_bas", "score_ic_haut", "publiable",
    "taux_abstention", "taux_presence", "taux_couverture",
    "nb_promesses_testees", "nb_promesses_total", "computed_at"
  )
  SELECT
    g."groupe_id",
    g."theme_id",
    ROUND((g."score_brut" + 1) * 50)::smallint,
    ROUND(g."score_brut", 4),
    g."nb_scrutins",
    "label_meteo"(ROUND((g."score_brut" + 1) * 50)::smallint, g."n_eff" >= p_seuil_groupe),
    ROUND(g."n_eff", 2),
    -- IC 95 % de Wilson sur le taux d'alignement
    ("score_intervalle"(g."score_brut", g."n_eff"))[1]::smallint,
    ("score_intervalle"(g."score_brut", g."n_eff"))[2]::smallint,
    g."n_eff" >= p_seuil_groupe,
    ROUND(g."taux_abstention", 4),
    ROUND(pres."taux_presence", 4),
    ROUND(cov."taux_couverture", 4),
    cov."nb_testees",
    cov."nb_total",
    now()
  FROM "tmp_score_groupe" g
  LEFT JOIN LATERAL (
    -- Présence du groupe = moyenne des taux de ses membres actuels
    SELECT AVG(pr."taux_presence") AS "taux_presence"
    FROM "tmp_presence" pr
    JOIN "dim_depute" d ON d."id" = pr."depute_id"
    WHERE d."groupe_id" = g."groupe_id" AND d."actif" = true
  ) pres ON true
  LEFT JOIN "tmp_couverture" cov
    ON cov."groupe_id" = g."groupe_id"
   AND cov."theme_id" IS NOT DISTINCT FROM g."theme_id";

  DELETE FROM "cache_score_depute" WHERE true;
  INSERT INTO "cache_score_depute" (
    "depute_id", "theme_id", "score_0_100", "score_brut", "nb_scrutins",
    "delta_vs_groupe", "label_meteo", "n_eff", "score_ic_bas", "score_ic_haut",
    "publiable", "taux_abstention", "taux_presence", "score_avant_shrinkage", "computed_at"
  )
  SELECT
    d."depute_id",
    d."theme_id",
    ROUND((d."score_shrunk" + 1) * 50)::smallint,
    ROUND(d."score_brut", 4),
    d."nb_scrutins",
    -- Écart au groupe : non significatif sous le seuil, donc NULL
    CASE WHEN d."n_eff" >= p_seuil_depute AND g."score_brut" IS NOT NULL
         THEN (ROUND((d."score_shrunk" + 1) * 50) - ROUND((g."score_brut" + 1) * 50))::smallint
         END,
    "label_meteo"(ROUND((d."score_shrunk" + 1) * 50)::smallint, d."n_eff" >= p_seuil_depute),
    ROUND(d."n_eff", 2),
    -- IC de Wilson centré sur le score rétréci — celui qui est affiché.
    -- Le rétrécissement ajoute k pseudo-observations : l'échantillon effectif
    -- de l'estimation a posteriori vaut donc n_eff + k.
    ("score_intervalle"(d."score_shrunk", d."n_eff" + p_k_shrinkage))[1]::smallint,
    ("score_intervalle"(d."score_shrunk", d."n_eff" + p_k_shrinkage))[2]::smallint,
    d."n_eff" >= p_seuil_depute,
    ROUND(d."taux_abstention", 4),
    ROUND(pr."taux_presence", 4),
    ROUND((d."score_brut" + 1) * 50)::smallint,
    now()
  FROM "tmp_score_depute" d
  LEFT JOIN "tmp_score_groupe" g
    ON g."groupe_id" = d."groupe_id"
   AND g."theme_id" IS NOT DISTINCT FROM d."theme_id"
  LEFT JOIN "tmp_presence" pr ON pr."depute_id" = d."depute_id";

  -- ══ Compte rendu ══
  RETURN QUERY
    SELECT 'groupe'::text, COUNT(*), COUNT(*) FILTER (WHERE "publiable")
    FROM "cache_score_groupe"
    UNION ALL
    SELECT 'depute'::text, COUNT(*), COUNT(*) FILTER (WHERE "publiable")
    FROM "cache_score_depute";
END;
$$;

COMMENT ON FUNCTION "refresh_scores" IS
  'Recalcule intégralement cache_score_groupe et cache_score_depute. '
  'À appeler en fin de pipeline ETL. Les paramètres sont exposés pour permettre '
  'l''analyse de sensibilité : faire varier p_poids_abstention (0 / 0,5 / 1) et '
  'p_k_shrinkage (5 / 8 / 15) et vérifier que le classement météo des groupes ne bascule pas.';

COMMIT;
