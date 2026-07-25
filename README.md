# ☀️ L'Éclaircie — Baromètre de la Redevabilité Politique (17e Législature)

> **L'Éclaircie** est une application **Civic Tech open-source française** qui mesure avec rigueur et neutralité la cohérence entre les promesses électorales des groupes politiques et leurs votes réels à l'Assemblée nationale.

---

## 🌤️ Le Concept

Face à la masse et à la complexité des textes de lois, L'Éclaircie agit comme la **météo de l'Assemblée nationale** pour rendre l'action politique lisible par tous :

- ☀️ **81 – 100** : Grand Soleil (Haute cohérence / Promesses respectées)
- 🌤️ **61 – 80** : Éclaircies (Cohérence globale avec nuances)
- ☁️ **31 – 60** : Nuages (Incohérences notables ou positions ambiguës)
- ⛈️ **0 – 30** : Orage (Opposition directe aux engagements électoraux)

### ⚖️ Neutralité Absolue & Validation Humaine
1. **Traçabilité Totale** : Chaque note s'appuie sur la citation exacte issue du programme PDF et le numéro officiel du scrutin public de l'Assemblée nationale (`VTANR5L17V...`).
2. **L'IA propose, l'humain valide** : Toutes les classifications générées automatiquement par IA restent au statut `brouillon` jusqu'à validation explicite par un administrateur sur l'interface d'administration `/admin`.

---

## 🛠️ Stack Technique

- **Frontend** : [Next.js 16 (App Router)](https://nextjs.org/) + [React 19](https://react.dev/)
- **Design & UI** : [Tailwind CSS v4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) + [Lucide Icons](https://lucide.dev/)
- **Base de Données & Auth** : [Supabase Free (PostgreSQL)](https://supabase.com/) + Row Level Security (RLS)
- **ETL Automatique** : Supabase Edge Functions (Deno/TypeScript) déclenchées par `pg_cron` (tous les jours à 3h00)
- **Intelligence Artificielle** : 
  - **Google Gemini 2.5 Flash** (Extraction lourde one-shot depuis les programmes PDF)
  - **Google Gemini 2.5 Flash-Lite** (Classification réactive nightly scrutins ↔ promesses)
- **Hébergement** : Vercel (Hobby) avec ISR 24h (`revalidate = 86400`)
- **Open Data** : Assemblée nationale (Fichiers JSON des députés et scrutins)

---

## 🚀 Démarrage Rapide

### 1. Prérequis
- **Node.js** 20+ et **npm**
- Une instance **Supabase** (Projet PostgreSQL gratuit)
- Une clé API **Google Gemini**

### 2. Installation
```bash
# Cloner le dépôt
git clone https://github.com/AssalHugo/L-claircie.git
cd L-claircie

# Installer les dépendances
npm install
```

### 3. Configuration de l'environnement (`.env.local`)
Créez un fichier `.env.local` à la racine du projet :
```bash
NEXT_PUBLIC_SUPABASE_URL=https://[votre-projet].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=AIzaSy...
```

### 4. Lancement du serveur de développement
```bash
npm run dev
```
Ouvrez [http://localhost:3000](http://localhost:3000) dans votre navigateur.

---

## 📊 Pipeline d'Ingestion & Scripts CLI (`scripts/`)

Les scripts de préparation et d'initialisation des données se trouvent dans le dossier `scripts/` et s'exécutent en CLI avec `npx tsx` :

```bash
# 1. Seeder les 10 thèmes nationaux (Retraites, Fiscalité, Écologie, etc.)
npx tsx scripts/00-seed-themes.ts

# 2. Télécharger l'Open Data AN et insérer les 577 députés & 12 groupes
npx tsx scripts/01-fetch-deputes.ts

# 3. Extraire les promesses depuis les PDF de campagne via Gemini 2.5 Flash
npx tsx scripts/02-extract-promesses.ts

# 4. Pré-analyser et vérifier la validité des promesses avec Gemini 2.5 Flash-Lite
npx tsx scripts/03-review-promesses.ts

# 5. Vérifier hors ligne le mapping ETL Open Data AN → schéma Supabase
#    (aucun accès base ni appel LLM — à lancer après toute modification de l'ETL)
npx tsx scripts/04-verify-etl-mapping.ts
```

---

## 🤖 ETL Automatique Nocturne

L'ETL tourne chaque nuit à 3h00 du matin via l'Edge Function Supabase `etl-nightly` :
1. Récupération des nouveaux scrutins publiés sur l'Open Data de l'Assemblée nationale.
2. Ingestion des votes individuels de chaque député.
3. Évaluation par LLM (Gemini 2.5 Flash-Lite) de la correspondance entre le scrutin et les promesses actives.
4. Enregistrement en mode `brouillon` pour revue dans `/admin`.

---

## 📁 Arborescence du Projet

```
├── scripts/                    # Scripts CLI d'ingestion et d'analyse locale (npx tsx)
├── src/
│   ├── app/                    # Routes Next.js App Router (Public & Admin)
│   │   ├── admin/              # Interface de modération (/admin, /admin/promesses)
│   │   ├── globals.css         # Styles globaux Tailwind CSS v4
│   │   ├── layout.tsx          # Layout racine de l'application
│   │   └── page.tsx            # Page d'accueil baromètre météo
│   ├── components/             # Composants UI réutilisables (shadcn/ui)
│   └── lib/                    # Clients Supabase, types TypeScript et utilitaires
├── supabase/
│   ├── functions/
│   │   └── etl-nightly/        # Edge Function Deno/TypeScript pour le pipeline nightly
│   ├── config.toml             # Configuration du CLI Supabase
├── civic_tech.sql              # Schéma de base de données PostgreSQL complet
├── AGENT.md                    # Guide d'architecture & directives pour les agents IA
├── CLAUDE.md                   # Raccourcis et conventions de développement pour Claude
└── README.md                   # Ce document
```

---

## 📖 Documentation Complémentaire

- [AGENT.md](file:///c:/Users/hugoa/Documents/L-claircie/AGENT.md) : Directives complètes d'architecture et règles pour agents IA.
- [CLAUDE.md](file:///c:/Users/hugoa/Documents/L-claircie/CLAUDE.md) : Commandes rapides et guides de développement pour assistants IA.
- [MVP Civic Tech _ Promesses vs Votes.md](file:///c:/Users/hugoa/Documents/L-claircie/MVP%20Civic%20Tech%20_%20Promesses%20vs%20Votes.md) : Spécification produit originale.

---

## 📜 Licence

Projet Open Source sous licence MIT. Libre de droit pour encourager la transparence démocratique.
