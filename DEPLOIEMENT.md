# 🚀 Mise en place du projet Supabase

Procédure complète, de la création du projet au premier score calculé.
Chaque étape est vérifiable : ne passez à la suivante qu'après le contrôle indiqué.

---

## ⚠️ À décider avant de commencer

**L'ETL ingère aujourd'hui les 8 434 scrutins de la législature et leurs 1,27 million
de votes individuels.** Or seuls **1 198 scrutins sont éligibles** au calcul du score :
les 7 221 votes d'amendements n'entrent dans aucun calcul.

| Périmètre d'ingestion | Lignes `fact_vote_individuel` | Poids estimé avec index |
|---|---|---|
| Tout (comportement actuel) | ~1 270 000 | **150 à 250 Mo** |
| Scrutins éligibles seulement | ~180 000 | ~30 Mo |

Le plan gratuit est limité à **500 Mo**. Le premier cas passe probablement, mais sans
marge pour la suite de la législature. Le second est confortable et ne perd aucune
donnée utile au score.

👉 **Recommandation : n'ingérer les votes que des scrutins éligibles.** C'est une
modification d'une dizaine de lignes dans `etl-nightly/index.ts` — demandez-la avant
de lancer le backfill, sinon vous devrez purger la table ensuite.

---

## 1. Créer le projet

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
