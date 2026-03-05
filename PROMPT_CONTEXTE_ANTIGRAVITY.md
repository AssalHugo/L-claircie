# Contexte Projet — L'Éclaircie (Civic Tech 2027)

Tu es mon assistant développeur principal sur ce projet. Lis ce document en entier avant de répondre à quoi que ce soit. Il contient tout le contexte nécessaire pour ne pas me faire répéter.

---

## 1. Description du projet

**L'Éclaircie** est une application Civic Tech open-source française qui mesure la cohérence entre les programmes électoraux des groupes politiques et leurs votes réels à l'Assemblée nationale, en vue des élections 2027.

L'interface utilise une **analogie météorologique** (☀️ Soleil, 🌤️ Éclaircies, ☁️ Nuages, ⛈️ Orage) pour rendre la politique lisible au grand public, avec une traçabilité totale des sources officielles en arrière-plan.

**Principe de neutralité absolue** : aucune donnée n'est affichée sans validation humaine. L'IA classe, l'admin approuve.

---

## 2. Stack technique (tout est déjà choisi, ne pas suggérer d'alternatives)

| Couche | Technologie |
|---|---|
| Frontend | Next.js App Router + Tailwind CSS + shadcn/ui |
| Hébergement | Vercel Hobby (gratuit) avec ISR 24h |
| Base de données | Supabase Free (PostgreSQL + Auth + RLS) |
| ETL automatique | Supabase Edge Functions déclenchées par pg_cron |
| IA extraction PDF | Google Gemini 2.5 Flash (programmes politiques, one-shot) |
| IA classification | Google Gemini 2.5 Flash-Lite (scrutins, nightly, récurrent) |
| Données parlementaires | Open Data officiel Assemblée nationale (ZIP JSON) |

**Contrainte budget stricte : < 5€/mois.** Toute suggestion dépassant ce budget est à rejeter.

---

## 3. Ce qui est déjà fait

### 3.1 Base de données Supabase
Le schéma SQL est déployé sur Supabase (région Paris). Les tables suivantes existent et sont peuplées :

**`dim_theme`** — 10 thèmes (retraites, fiscalite, immigration, ecologie, sante, securite, education, pouvoir-achat, institutions, international)

**`dim_groupe`** — 12 groupes politiques de la 17e législature :
- RN, EPR, LFI-NFP, SOC, DR, ECOS, DEM, HOR, LIOT, GDR, UDDPLR, NI
- Colonnes : `id`, `uid_officiel` (ex: "PO845401"), `sigle`, `nom_complet`, `couleur_hex`, `nb_sieges`, `actif`

**`dim_depute`** — 577 députés actifs
- Colonnes : `id`, `uid_an` (ex: "PA841605"), `nom`, `prenom`, `groupe_id`, `departement`, `num_circo`, `profession`, `photo_url`, `actif`

**`dim_depute_groupe_historique`** — 577 entrées (historique des changements de groupe)
- Colonnes : `id`, `depute_id`, `groupe_id`, `date_debut` (2024-07-18), `date_fin` (NULL = actuel)

**`dim_promesse`** — promesses extraites des PDF (en cours de peuplement)
- Colonnes : `id`, `groupe_id`, `theme_id`, `intitule_court`, `description_longue`, `source_pdf_nom`, `source_pdf_page`, `source_pdf_annee`, `source_citation`, `statut` ('active'|'suspendue'|'retiree'), `statut_validation` (NULL|'auto'|'review'|'valide'), `statut_publication` ('brouillon'|'publie')

**`fact_scrutin`** — votes à l'AN (à peupler par ETL)
- Colonnes : `id`, `uid_an` (ex: "VTANR5L17V0842"), `date_scrutin`, `objet`, `expose_des_motifs`, `llm_traite`, `pertinent`

**`fact_vote_individuel`** — vote de chaque député sur chaque scrutin
- Colonnes : `id`, `scrutin_id`, `depute_id`, `groupe_id_au_moment_du_vote`, `position_vote` (1=Pour, -1=Contre, 0=Abstention, NULL=Absent)

**`llm_classification`** — lien scrutin ↔ promesse (produit par l'ETL IA)
- Colonnes : `id`, `scrutin_id`, `promesse_id`, `polarite_llm` (1|-1), `confidence_score`, `raisonnement_llm`, `prompt_hash`, `statut_validation` ('auto'|'review'|'valide'|'rejete'), `statut_publication` ('brouillon'|'publie')

**`cache_score_groupe`** — scores pré-calculés par groupe × thème
- Colonnes : `id`, `groupe_id`, `theme_id`, `score_0_100`, `score_brut`, `computed_at`

**`cache_score_depute`** — scores par député × thème
- Colonnes : `id`, `depute_id`, `theme_id`, `score_0_100`, `score_brut`, `delta_vs_groupe`, `computed_at`

**`user_preferences`** — préférences utilisateurs (thèmes favoris, circonscription)

**`etl_run_log`** — logs des runs ETL avec coût Gemini en USD

### 3.2 RLS (Row Level Security)
- Toutes les tables ont RLS activé
- Lecture publique (anon) sur toutes les tables sauf user_preferences
- `llm_classification` : lecture publique filtrée sur `statut_publication = 'publie'`
- `dim_promesse` : lecture publique filtrée sur `statut = 'active'`
- Écriture uniquement via `service_role` key (ETL) ou compte admin authentifié

### 3.3 Scripts d'ingestion (locaux, CLI uniquement)
Ces scripts tournent en local depuis `scripts/` avec `npx tsx`. **Ils ne sont PAS dans Next.js et ne doivent pas y être intégrés.**

- `00-seed-themes.ts` ✅ — peuple dim_theme
- `01-fetch-deputes.ts` ✅ — télécharge ZIP AN, peuple dim_groupe + dim_depute + historique
- `02-extract-promesses.ts` ✅ — envoie PDFs à Gemini 2.5 Flash, peuple dim_promesse
- `03-review-promesses.ts` ✅ — relit les promesses avec Gemini 2.5 Flash-Lite, trie auto/review

---

## 4. Ce qui reste à construire

### 4.1 ETL automatique (Supabase Edge Functions + pg_cron) — PRIORITÉ 1
Une Edge Function TypeScript qui tourne chaque nuit à 3h :
1. Télécharge les nouveaux scrutins depuis l'Open Data AN
2. Filtre ceux absents de `fact_scrutin` (déduplication par `uid_an`)
3. Insère dans `fact_scrutin` + `fact_vote_individuel`
4. Pour chaque nouveau scrutin : appelle Gemini 2.5 Flash-Lite avec les promesses en cache
5. Insère dans `llm_classification` avec `statut_publication = 'brouillon'`
6. Log dans `etl_run_log`

Déclenchement : `SELECT cron.schedule('etl-nightly', '0 3 * * *', 'SELECT net.http_post(...)');`
Heartbeat anti-pause Supabase : cron hebdomadaire qui ping la base pour éviter la mise en veille après 7 jours d'inactivité.

### 4.2 Interface admin Next.js — PRIORITÉ 2
Route `/admin` protégée par Supabase Auth (compte unique, pas d'inscription publique).

**Pages à construire :**

**`/admin`** — Dashboard
- Nombre de scrutins en attente de classification
- Nombre de classifications en brouillon à valider
- Coût Gemini du dernier ETL run
- Dernier run ETL (date + statut)
- Bouton "Forcer run ETL" (appelle l'Edge Function manuellement)

**`/admin/promesses`** — Gestion des promesses
- Table avec filtre par groupe, thème, statut_validation
- Vue par défaut : filtre `statut_validation = 'review'` (les ~100 à relire)
- Actions par ligne : Valider / Modifier / Retirer
- Affichage : intitule_court, source_citation, groupe, thème, flags de review (biais/concordance/concretude/temporel)

**`/admin/classifications`** — Validation des votes IA
- Table des `llm_classification` en `statut_publication = 'brouillon'`
- Pour chaque ligne : affiche le scrutin (objet + date) + la promesse liée + polarité IA + score de confiance + raisonnement
- Actions : Approuver (→ 'publie') / Rejeter (→ 'rejete')
- Filtre par groupe, thème, date

**`/admin/scrutins`** — Vue des scrutins
- Liste des derniers fact_scrutin avec statut de traitement LLM
- Lien vers le texte officiel de l'AN

### 4.3 Interface publique Next.js — PRIORITÉ 3

**`/`** — Page d'accueil météo
- 11 cartes groupe (exclure NI des scores)
- Icône météo selon score_0_100 : ☀️ 81-100, 🌤️ 61-80, ☁️ 31-60, ⛈️ 0-30
- Filtre par thème (les 10 thèmes)
- ISR revalidate: 86400 (24h)

**`/groupe/[sigle]`** — Page détail groupe
- Score global + scores par thème
- Liste des promesses du groupe
- Fil des derniers votes avec phrase déclarative ("Le RN a voté POUR la loi X")
- Mode Expert : modal avec citation PDF + texte de loi

**`/depute/[uid]`** — Page député (V2)
- Score individuel + delta vs groupe
- Historique de votes

---

## 5. Conventions de code

- TypeScript strict partout
- Supabase client côté serveur : `createClient` avec `service_role` key dans les API Routes / Server Actions
- Supabase client côté client : `createBrowserClient` avec `anon` key uniquement
- Pas de `any` dans les types — toujours typer les réponses Supabase
- Composants UI : shadcn/ui exclusivement (pas d'autres librairies UI)
- Styles : Tailwind uniquement, pas de CSS custom sauf cas exceptionnel
- Fetch données : React Server Components + Server Actions (pas de `useEffect` + fetch)
- Gestion d'erreurs : toujours logger dans `etl_run_log` pour les ETL, toast côté client pour les actions admin

---

## 6. Variables d'environnement

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=AIzaSy...
```

---

## 7. Décisions architecturales figées (ne pas remettre en question)

1. **Pas d'API REST custom** — tout passe par Supabase directement (RPC, RLS, Realtime)
2. **ETL dans Supabase Edge Functions** — pas dans Next.js API Routes (timeout Vercel incompatible)
3. **Scripts CLI locaux** — l'ingestion initiale (PDFs, deputies) reste en local, jamais dans l'app
4. **ISR 24h** — pas de SSR temps réel pour les pages publiques (trop coûteux sur Hobby)
5. **Gemini 2.5 Flash** pour les tâches complexes one-shot, **Gemini 2.5 Flash-Lite** pour les tâches récurrentes simples
6. **NI (Non-inscrits)** exclu du scoring public — pas de programme commun à évaluer
7. **statut_publication = 'publie'** est le seul filtre pour les données publiques — double sécurité avec statut_validation

---

## 8. Ce que j'attends de toi

- Tu génères du code complet et fonctionnel, pas des snippets incomplets
- Tu respectes les conventions ci-dessus sans les remettre en question
- Si tu as besoin d'un schéma Supabase précis, demande-moi la table concernée
- Tu signales proactivement si quelque chose dans ma demande est incompatible avec la stack ou le budget
- Tu codes en français pour les commentaires et les messages UI, en anglais pour les noms de variables/fonctions

