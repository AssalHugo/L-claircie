# 🚀 Mise en place du projet Supabase

Procédure complète, de la création du projet au premier score calculé.
Chaque étape est vérifiable : ne passez à la suivante qu'après le contrôle indiqué.

---

## 📦 Volume attendu

Tailles **mesurées** sur PostgreSQL 17.6, pas estimées :

| Table | Lignes | Table | Index | Total |
|---|---|---|---|---|
| `fact_vote_individuel` | 1 270 476 | 63 Mo | 79 Mo | **143 Mo** |
| `fact_scrutin` | 8 434 | | | 6 Mo |
| `llm_classification` | ~4 800 | | | 2 Mo |
| dimensions + caches | | | | ~5 Mo |
| | | | | **≈ 156 Mo** |

Soit **31 % du plafond de 500 Mo** du plan gratuit. La marge est confortable pour
toute la législature.

**L'ETL ingère tous les votes nominatifs par défaut**, et pas seulement ceux des
1 198 scrutins éligibles au score. Ils servent aussi aux statistiques comparatives —
loyauté d'un député envers son groupe, proximité entre groupes, cohésion. S'en tenir
aux scrutins éligibles ne réduirait pas seulement la précision de ces mesures : cela
les **biaiserait**, les votes d'amendements étant précisément ceux où la discipline
de groupe se relâche.

Si le volume devenait un problème, deux leviers dans cet ordre :

1. la clé primaire `id` de `fact_vote_individuel` coûte **27 Mo** d'index et fait
   doublon avec l'index unique naturel `(depute_id, scrutin_id)` ;
2. le paramètre `{"votes":"eligibles"}` restreint l'ingestion aux scrutins éligibles
   (~199 000 votes, ~30 Mo). La colonne `votes_ingeres` rend le choix réversible :
   repasser en périmètre complet déclenche le rattrapage automatique des votes
   manquants, sans ré-ingestion.

---

## 💶 Ce que ça coûte

Chiffrage bâti sur des mesures, pas des hypothèses : taille réelle des 6 programmes
à extraire (43 928 tokens), 1 198 scrutins éligibles au backfill, et **64 scrutins
éligibles par mois** en moyenne sur les 12 derniers mois d'activité parlementaire.

Reste estimé : ~600 promesses extraites (~250 tokens de JSON chacune) et ~2 780 tokens
d'entrée par classification (prompt + 40 promesses pré-filtrées + scrutin).

### Peuplement initial — une seule fois

| Étape | Économique | Recommandé |
|---|---|---|
| Extraction des promesses | 0,39 $ | 1,20 $ |
| Relecture des promesses | 0,09 $ | 0,09 $ |
| Classification des 1 198 scrutins | 1,19 $ | 8,39 $ |
| **Total** | **1,67 $** (~1,55 €) | **9,68 $** (~8,90 €) |
| *avec Batch API (−50 %)* | *0,84 $* | *4,84 $* |

- **Économique** : tout en Flash-Lite, classification en passe simple.
- **Recommandé** (§8.4 de l'audit) : extraction avec `gemini-3.6-flash` — c'est la
  *ground truth*, une promesse mal extraite contamine tous les scores en aval — et
  classification en **double passe** `3.6-flash` + `3.5-flash-lite`, l'accord entre
  deux familles de modèles étant un bien meilleur signal de confiance que la
  `confidence` auto-déclarée.

**L'écart entre les deux scénarios est de 8 $, une seule fois.** À ce niveau, le
critère de choix n'est pas le prix mais la justesse.

> 💡 **Le palier gratuit Gemini peut absorber tout le backfill.** Il plafonne à
> ~1 000–1 500 requêtes/jour et 15 requêtes/minute selon le modèle. Le backfill
> demande 1 234 requêtes en passe simple, 2 432 en double passe : deux à trois jours
> d'étalement, pour 0 €. Deux réserves — les prompts du palier gratuit **peuvent être
> utilisés pour entraîner les modèles** (sans gravité ici, tout est déjà public), et
> à 15 req/min il faut baisser `max_classify` à ~20 pour tenir dans les 150 s
> d'une Edge Function.

### Coût mensuel récurrent

| Poste | Économique | Recommandé |
|---|---|---|
| Classification (~64 scrutins/mois) | 0,06 $ | 0,45 $ |
| Supabase — plan Free | 0,00 $ | 0,00 $ |
| Vercel — plan Hobby | 0,00 $ | 0,00 $ |
| Nom de domaine | ~1,50 $ | ~1,50 $ |
| **Total** | **~1,56 $/mois** (~1,45 €) | **~1,95 $/mois** (~1,80 €) |

**Le nom de domaine coûte plus cher que l'intelligence artificielle.** Le budget
< 5 €/mois est tenu avec une marge de 2,5×.

### Marges par rapport aux plafonds gratuits

| Ressource | Plafond | Usage projeté | Marge |
|---|---|---|---|
| Supabase — base de données | 500 Mo | ~156 Mo | 3,2× |
| Supabase — egress | 5 Go/mois | quelques centaines de Mo | large |
| Supabase — Edge Functions | 500 000/mois | ~30 | 16 000× |
| Supabase — projets actifs | 2 | 1 | — |
| Vercel — bande passante | 100 Go/mois | faible (ISR 24 h) | large |

Trois points de vigilance, sans rapport avec le prix :

- **Pause après 7 jours d'inactivité** sur le plan Free → battement `pg_cron` hebdomadaire (étape 8).
- **2 s de CPU par Edge Function.** Le téléchargement et le parsing des 8 434 fichiers
  du ZIP est l'opération la plus lourde du pipeline : si l'ingestion échoue, baisser
  `max_ingest`.
- **Vercel Hobby interdit l'usage commercial.** Un projet civique non lucratif est
  dans les clous ; ouvrir des dons ferait techniquement basculer dans le plan Pro.

### Vérifier les coûts réels

L'ETL enregistre le coût de chaque run — inutile de rester sur des estimations :

```sql
SELECT date_trunc('month', created_at) AS mois,
       sum(cout_llm_usd) AS cout_usd,
       sum(nb_classes)   AS classifications
FROM etl_run_log GROUP BY 1 ORDER BY 1 DESC;
```

---

## 0. Vous avez déjà un projet Supabase ?

**Ne le jetez pas sans avoir regardé ce qu'il contient.** L'ancien ETL était cassé —
il n'insérait rien, y compris dans son propre journal d'erreurs. Les tables de faits
sont donc probablement vides, mais les scripts `00` à `03`, eux, fonctionnaient :
vos **promesses extraites et relues à la main** sont la partie coûteuse à refaire.

Inspection préalable, dans **SQL Editor** :

```sql
SELECT 'dim_theme' AS t, count(*) FROM dim_theme
UNION ALL SELECT 'dim_groupe',          count(*) FROM dim_groupe
UNION ALL SELECT 'dim_depute',          count(*) FROM dim_depute
UNION ALL SELECT 'dim_promesse',        count(*) FROM dim_promesse
UNION ALL SELECT 'dim_promesse validées', count(*) FROM dim_promesse WHERE statut IN ('valide','auto')
UNION ALL SELECT 'fact_scrutin',        count(*) FROM fact_scrutin
UNION ALL SELECT 'fact_vote_individuel',count(*) FROM fact_vote_individuel
UNION ALL SELECT 'llm_classification',  count(*) FROM llm_classification;
```

| Ce que vous voyez | Ce qu'il faut faire |
|---|---|
| `dim_promesse` peuplée, faits vides | **Garder le projet.** Sauvegarde, puis `db push` (étape 4). Les migrations sont idempotentes et conçues pour une base existante. Vous économisez l'extraction et surtout votre relecture. |
| Tout est vide ou presque | Repartir propre : `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` puis `db push`. Inutile de créer un second projet — le plan Free n'en autorise que 2. |
| Faits peuplés par l'ancien ETL | Purger les faits seulement : voir ci-dessous. |

### Outillage : ni `psql` ni `pg_dump` à installer

Le conteneur Docker de Supabase les embarque déjà (PostgreSQL 17.6, même version
que le serveur distant). Deux précautions propres à cet environnement :

- **Utiliser la chaîne « Session pooler »**, pas « Direct connection ».
  `db.<ref>.supabase.co` ne résout qu'en IPv6, or les conteneurs Docker n'ont pas
  d'IPv6 globale : la connexion directe échoue. Le pooler est en IPv4.
  → **Settings → Database → Connection string → Session pooler**
- **Préfixer par `MSYS_NO_PATHCONV=1`** sous Git Bash, sinon `/tmp/x.sql` est
  converti en chemin Windows et `psql` ne trouve pas le fichier.

```bash
# Le mot de passe reste dans une variable de shell, jamais dans un fichier versionné.
export DBURL='postgresql://postgres.<ref>:<motdepasse>@aws-0-<region>.pooler.supabase.com:5432/postgres'
```

### a. Sauvegarder

```bash
docker exec -e PGURL="$DBURL" supabase_db_civicTech \
  sh -c 'pg_dump "$PGURL" -Fc -f /tmp/sauvegarde.dump'
docker cp supabase_db_civicTech:/tmp/sauvegarde.dump ./sauvegarde-avant-migrations.dump
ls -lh sauvegarde-avant-migrations.dump
```

Restauration, si besoin : `pg_restore -d "$DBURL" --clean sauvegarde-avant-migrations.dump`

### b. Inspecter

```bash
docker cp scripts/sql/01-inspecter-base-existante.sql supabase_db_civicTech:/tmp/inspect.sql
MSYS_NO_PATHCONV=1 docker exec -e PGURL="$DBURL" supabase_db_civicTech \
  sh -c 'psql "$PGURL" -f /tmp/inspect.sql'
```

Lire en priorité la **section 2** : si `numero`, `titre` ou `sort_adopte` sont
`is_nullable = YES`, votre schéma diverge du schéma versionné — c'est ce qui a permis
à l'ancien ETL d'insérer des scrutins incomplets.

### c. Purger les faits

```bash
docker cp scripts/sql/02-purger-donnees-ancien-pipeline.sql supabase_db_civicTech:/tmp/purge.sql
MSYS_NO_PATHCONV=1 docker exec -e PGURL="$DBURL" supabase_db_civicTech \
  sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -f /tmp/purge.sql'
```

Le script affiche les compteurs avant et après. `dim_promesse` doit rester intacte.

> Les données produites par l'ancien pipeline sont à écarter quoi qu'il arrive :
> `groupe_id_au_moment_du_vote` y contenait le groupe *actuel* du député et non celui
> de la date du vote, et les scrutins n'avaient ni `eligible` ni `categorie`.

Une fois l'inspection faite, passez directement à l'**étape 2** (les clés) : votre
projet existe déjà.

---

## 1. Créer le projet

*(à sauter si vous conservez votre projet existant — voir étape 0)*

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. Renseigner :
   - **Name** : `leclaircie`
   - **Database Password** : générer et **conserver** (nécessaire pour `db push`)
   - **Region** : **Europe West (Paris)** — données françaises, latence, RGPD
   - **Plan** : Free
3. Attendre la fin du provisionnement (~2 min)

**Contrôle** : le tableau de bord affiche « Project is healthy ».

---

## 2. Récupérer les clés

**Project Settings → API** :

| Valeur | Usage | Sensibilité |
|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | publique |
| `anon` / publishable | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publique (embarquée dans le navigateur) |
| `service_role` / secret | `SUPABASE_SERVICE_ROLE_KEY` | **secrète — contourne la RLS** |

Créer `.env.local` à la racine (déjà dans `.gitignore`) :

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
GEMINI_API_KEY=...
```

> La clé `service_role` ne doit jamais apparaître dans du code client, ni dans une
> variable préfixée `NEXT_PUBLIC_`. Elle donne un accès total à la base.

---

## 3. 🔒 Fermer les inscriptions publiques

**Authentication → Sign In / Providers → Email** → désactiver **Enable sign ups**.

Sans cela, n'importe qui peut créer un compte. Il ne serait pas administrateur pour
autant — l'autorisation vient de la table `admin_utilisateur` — mais il n'y a aucune
raison d'ouvrir l'inscription sur un projet à administrateur unique.

**Contrôle** : une tentative d'inscription depuis l'API renvoie une erreur.

---

## 4. Appliquer les migrations

```bash
npx supabase link --project-ref <ref-du-projet>
npx supabase db push
```

Le `<ref>` est la sous-chaîne de l'URL : `https://<ref>.supabase.co`.
Le mot de passe demandé est celui de l'étape 1.

Les six migrations s'appliquent dans l'ordre :

| Migration | Contenu |
|---|---|
| `00000000000000_init_schema` | schéma de base (tables, index, clés étrangères) |
| `20260725100000_baseline` | colonnes manquantes, `statut` nullable |
| `20260725120000_sprint2` | sélection du corpus, promesses canoniques |
| `20260725140000_sprint3` | calcul des scores, météo, intervalles |
| `20260725160000_rls` | politiques d'accès |
| `20260725180000_admin` | table d'autorisation de l'administration |
| `20260725200000_ingestion_ciblee` | suivi des votes chargés (`votes_ingeres`) |

**Contrôle** :

```bash
npx supabase migration list
```

Puis, dans **SQL Editor**, vérifier que la RLS est bien active partout :

```sql
SELECT count(*) FILTER (WHERE rowsecurity) || '/' || count(*) AS rls_actives
FROM pg_tables WHERE schemaname = 'public';
-- attendu : 15/15
```

---

## 5. Créer le compte administrateur

Le premier administrateur ne peut pas se créer lui-même — sinon la porte resterait
ouverte. Deux étapes manuelles, une seule fois.

**a.** **Authentication → Users → Add user** → « Create new user »
- e-mail et mot de passe
- cocher **Auto Confirm User**

**b.** Copier l'UUID affiché, puis dans **SQL Editor** :

```sql
INSERT INTO admin_utilisateur (user_id, email, nom)
VALUES ('<uuid-copié>', 'vous@exemple.fr', 'Votre nom');
```

**Contrôle** : `npm run dev`, puis `/admin` doit rediriger vers `/admin/login`,
et vos identifiants doivent donner accès. Un autre compte doit être refusé
avec « Ce compte n'est pas autorisé ».

Pour révoquer un accès plus tard, sans perdre la trace :

```sql
UPDATE admin_utilisateur SET actif = false WHERE email = '...';
```

---

## 6. Peupler le socle de vérité

Dans l'ordre — chaque script dépend du précédent :

```bash
npx tsx scripts/00-seed-themes.ts       # 10 thèmes
npx tsx scripts/01-fetch-deputes.ts     # groupes + députés + historique
npx tsx scripts/02-extract-promesses.ts # promesses via Gemini (~2 $, une seule fois)
npx tsx scripts/03-review-promesses.ts  # relecture automatique → statut auto/review
```

**Contrôle** après chaque étape :

```sql
SELECT
  (SELECT count(*) FROM dim_theme)                                    AS themes,      -- 10
  (SELECT count(*) FROM dim_groupe)                                   AS groupes,     -- ~12
  (SELECT count(*) FROM dim_depute)                                   AS deputes,     -- ~577
  (SELECT count(*) FROM dim_promesse WHERE est_canonique)             AS promesses,
  (SELECT count(*) FROM promesse_groupe)                              AS liaisons;
```

`liaisons` doit dépasser `promesses` : les programmes communs (NFP, Ensemble) sont
rattachés à plusieurs groupes sans être dupliqués.

**Puis relire dans `/admin/promesses`** les promesses en `review` et les passer en
`valide` ou `retiree`. Seules les promesses validées entrent dans le calcul.

---

## 7. Déployer l'ETL

```bash
npx supabase functions deploy etl-nightly
npx supabase secrets set GEMINI_API_KEY=...
```

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement.

### Backfill initial

À faire **avant** d'activer le cron, en deux temps :

```bash
FN="https://<ref>.supabase.co/functions/v1/etl-nightly"
SR="<service_role_key>"

# Phase 1 — ingestion seule, à répéter jusqu'à scrutinsDetectes = 0
curl -X POST "$FN" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
     -d '{"phase":"ingest","max_ingest":300}'

# Phase 2 — classification, à répéter jusqu'à fileAttenteRestante = 0
curl -X POST "$FN" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
     -d '{"phase":"classify","max_classify":40}'
```

La réponse JSON indique `scrutinsDetectes` et `fileAttenteRestante` : c'est ce qui
vous dit s'il reste du travail. Rien n'est perdu entre deux appels — la file d'attente
vit en base.

`scrutinsRepares` compte les scrutins dont les votes manquaient et viennent d'être
chargés — un run interrompu se rattrape donc tout seul au suivant.

**Contrôle du volume** une fois l'ingestion terminée :

```sql
SELECT
  count(*)                                     AS scrutins,
  count(*) FILTER (WHERE eligible)             AS eligibles,
  count(*) FILTER (WHERE NOT votes_ingeres)    AS votes_manquants,
  (SELECT count(*) FROM fact_vote_individuel)  AS votes,
  pg_size_pretty(pg_database_size(current_database())) AS taille_base
FROM fact_scrutin;
-- attendu en fin de backfill : ~8434 / ~1198 / 0 / ~1 270 000
```

> Une Edge Function du plan gratuit est limitée à **2 s de CPU** et 150 s d'horloge.
> Si l'ingestion échoue par dépassement, réduisez `max_ingest` (100, puis 50).
> C'est aussi l'argument principal pour restreindre le périmètre (voir en haut).

---

## 8. Planifier le run nocturne

**Database → Extensions** : activer `pg_cron` et `pg_net`.

Puis dans **SQL Editor** (⚠️ la clé apparaît en clair dans la définition du job —
utilisez Vault si cela vous gêne) :

```sql
SELECT cron.schedule(
  'etl-nightly',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/etl-nightly',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer <service_role_key>'),
    body    := '{}'::jsonb
  );
  $$
);
```

**Battement hebdomadaire** — le plan gratuit met le projet en pause après 7 jours
d'inactivité :

```sql
SELECT cron.schedule('heartbeat', '0 12 * * 1', $$SELECT 1$$);
```

**Contrôle** :

```sql
SELECT jobname, schedule, active FROM cron.job;
SELECT statut, nb_scrutins_nouveaux, nb_classes, nb_erreurs, cout_llm_usd, created_at
FROM etl_run_log ORDER BY created_at DESC LIMIT 5;
```

---

## 9. Valider les classifications, puis calculer

Les classifications arrivent en `statut_publication = 'brouillon'` : **elles n'entrent
dans aucun score tant qu'un humain ne les a pas publiées.** C'est le verrou du projet,
et il est appliqué par la RLS, pas seulement par convention.

```sql
-- Ce qui attend une relecture
SELECT count(*) FROM llm_classification WHERE statut_publication = 'brouillon';
```

L'écran d'administration correspondant n'existe pas encore. En attendant, la
publication se fait en SQL, promesse par promesse ou par lot :

```sql
UPDATE llm_classification SET statut_publication = 'publie' WHERE id IN (...);
```

Puis recalculer :

```sql
SELECT * FROM refresh_scores();

SELECT g.sigle, c.score_0_100, c.label_meteo, c.n_eff, c.publiable,
       c.score_ic_bas, c.score_ic_haut, c.taux_couverture
FROM cache_score_groupe c
JOIN dim_groupe g ON g.id = c.groupe_id
WHERE c.theme_id IS NULL
ORDER BY c.score_0_100 DESC;
```

---

## 10. Contrôle de sécurité final

Avant de rendre l'URL publique, rejouer les tests avec la chaîne de connexion du
projet (**Project Settings → Database → Connection string**) :

```bash
psql "$DATABASE_URL" -f supabase/tests/test_rls.sql
```

Attendu : **24 contrôles OK**. Ce test rejoue, avec le rôle `anon`, chacune des
attaques possibles depuis la clé publique.

⚠️ Ce script insère des données d'essai dans une transaction annulée. Il suppose une
base **sans données réelles** pour certaines assertions de comptage : à lancer de
préférence en local ou sur un projet de test.

---

## Récapitulatif de l'ordre

```
1. Créer le projet (région Paris)
2. Clés → .env.local
3. 🔒 Fermer les inscriptions publiques
4. npx supabase db push
5. Créer l'administrateur (dashboard + INSERT)
6. Scripts 00 → 01 → 02 → 03, puis relecture dans /admin
7. Déployer l'ETL + backfill
8. Planifier le cron + battement
9. Publier les classifications, puis refresh_scores()
10. Rejouer test_rls.sql
```

**Ne sautez pas l'étape 3.** Et ne rendez pas l'URL publique avant l'étape 10.
