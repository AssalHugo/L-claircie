# CLAUDE.md — Instructions & Quick Reference pour Claude

Ce document résume les commandes essentielles, les conventions de code et les directives techniques pour **Claude** (ou tout assistant de la famille Anthropic) travaillant sur le dépôt **L-claircie**.

---

## 💻 Commandes Frequentes

### Développement Web (Next.js)
```bash
npm run dev        # Lancer le serveur de dev local (http://localhost:3000)
npm run build      # Compiler le projet Next.js pour la production
npm run start      # Lancer le serveur de production compilé
npm run lint       # Vérifier le linter ESLint
```

### Scripts CLI d'Ingestion & Traitement (`scripts/`)
Les scripts d'ingestion s'exécutent en local depuis la racine du projet à l'aide de `npx tsx` :
```bash
npx tsx scripts/00-seed-themes.ts       # Seeder les 10 thèmes initiaux dans Supabase
npx tsx scripts/01-fetch-deputes.ts      # Télécharger Open Data AN & peupler députés/groupes
npx tsx scripts/02-extract-promesses.ts # Extraire les promesses PDF via Gemini 2.5 Flash
npx tsx scripts/03-review-promesses.ts  # Analyser les promesses via Gemini 2.5 Flash-Lite
npx tsx scripts/04-verify-etl-mapping.ts # Vérifier le mapping ETL AN → schéma (hors ligne, sans DB ni LLM)
```

Le script `04` rejoue la logique pure de l'ETL (`supabase/functions/etl-nightly/lib.ts`) sur le corpus
réel des scrutins et contrôle les invariants du schéma. À lancer après toute modification de l'ETL.
Options : `SCRUTINS_DIR=<dossier>` pour réutiliser une archive déjà décompressée,
`SCRUTINS_LIMIT=<n>` pour une itération rapide.

### Migrations de base de données
```bash
npx supabase db push          # Appliquer les migrations de supabase/migrations/
npx supabase migration list   # Voir l'état des migrations
```

### Tests SQL (scores et sécurité)
```bash
psql "$DATABASE_URL" -f supabase/tests/test_refresh_scores.sql
psql "$DATABASE_URL" -f supabase/tests/test_rls.sql
```

`test_rls.sql` rejoue avec le rôle `anon` chacune des attaques possibles depuis la clé publique
(publier un brouillon, réécrire un score, supprimer les votes). À relancer après toute
modification des politiques RLS ou ajout de table.

Le script tourne dans une transaction annulée : il n'écrit rien durablement. Il attend une base
**sans données réelles** (les assertions de présence et de couverture comptent tous les scrutins).
À lancer après toute modification de `refresh_scores()` ou de la formule de score.

### Supabase & Edge Functions
```bash
# Tester l'Edge Function ETL en local
npx supabase functions serve etl-nightly

# Déployer l'Edge Function sur le projet Supabase
npx supabase functions deploy etl-nightly
```

---

## 🔑 Variables d'Environnement Requis (`.env.local`)

```bash
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=AIzaSy...
```

---

## 📐 Conventions de Code & Architecture

### 1. TypeScript & Qualité
- **TypeScript strict** sur 100% du projet.
- **Interdiction formelle d'utiliser `any`**. Toujours typer explicitement les entrées, sorties et retours de requêtes Supabase (cf. `src/lib/types.ts`).

### 2. Next.js App Router & React 19
- **Server Components par défaut** pour la récupération de données public (ISR avec `revalidate = 86400`).
- Utiliser les **Server Actions** pour les mutations et interactions (ex: `src/app/admin/promesses/actions.ts`).
- Éviter les `useEffect` + `fetch` côté client pour les données d'affichage.

### 3. Securite & Supabase Client
- Côté **Serveur / Edge / Server Actions** : Utiliser `createClient` avec la clé `SUPABASE_SERVICE_ROLE_KEY` uniquement pour les opérations d'administration/ETL.
- Côté **Navigateur / Client** : Utiliser `createBrowserClient` avec `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Respecter les politiques RLS (`statut_publication = 'publie'` pour la partie publique, `statut_publication = 'brouillon'` restreint à l'admin).

### 4. Styles & UI
- **Tailwind CSS v4** et **shadcn/ui** exclusivement.
- Ne pas ajouter de librairies CSS tierces ou d'autres frameworks UI sans validation.
- Respecter l'analogie météo (☀️ 🌤️ ☁️ ⛈️) et la charte graphique.

### 5. Langue & Internationalisation
- **Code & Identifiants** (fonctions, variables, composants, champs SQL) : **Anglais** (ex: `getGroupScore`, `promesseId`, `confidence_score`).
- **Commentaires & Textes UI** : **Français**.

---

## 🧠 Modèles IA & Rôles

- **Google Gemini 2.5 Flash** : Tâches complexes et ponctuelles à forte quantité de données (extraction de texte depuis les PDF de programmes).
- **Google Gemini 2.5 Flash-Lite** : Tâches récurrentes nocturnes et classifications simples (match scrutin ↔ promesse dans l'ETL nightly).
