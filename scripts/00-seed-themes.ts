/**
 * 00-seed-themes.ts
 * -----------------
 * Peuple la table dim_theme avec la taxonomie thématique.
 *
 * À lancer UNE SEULE FOIS avant tous les autres scripts.
 * Sécurisé par upsert : relancer ce script ne créera pas de doublons.
 *
 * Usage (depuis la racine du projet) :
 *   npx tsx scripts/00-seed-themes.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

// Charge les variables d'environnement depuis .env.local à la racine du projet
dotenv.config({ path: ".env.local" });

// ─── Validation des variables d'environnement ──────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error("Variables manquantes dans .env.local :");
  if (!SUPABASE_URL) console.error("   → NEXT_PUBLIC_SUPABASE_URL");
  if (!SUPABASE_SERVICE) console.error("   → SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// IMPORTANT : on utilise la SERVICE_ROLE_KEY (pas la anon key)
// Elle bypass le RLS et permet l'écriture depuis ce script.
// Ne jamais l'exposer côté client ou dans du code Next.js public.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// ─── Données des thèmes ────────────────────────────────────────────────────
// Ces thèmes sont la colonne vertébrale de l'app :
//   - ils structurent les promesses extraites des PDF
//   - ils permettent la personnalisation "onboarding" de l'utilisateur
//   - ils filtrent l'affichage de la météo par sujet
//
//  Si tu modifies un slug ici APRÈS avoir extrait des promesses,
//     tu devras mettre à jour dim_promesse.theme_id en cascade.
//     Considère donc ces slugs comme IMMUTABLES une fois validés.
const THEMES = [
  { slug: "retraites", label: "Retraites & Travail", emoji: "👷", ordre: 1 },
  { slug: "fiscalite", label: "Fiscalité & Budget", emoji: "💰", ordre: 2 },
  { slug: "immigration", label: "Immigration", emoji: "🛂", ordre: 3 },
  { slug: "ecologie", label: "Écologie & Énergie", emoji: "🌿", ordre: 4 },
  { slug: "sante", label: "Santé", emoji: "🏥", ordre: 5 },
  { slug: "securite", label: "Sécurité & Justice", emoji: "🚔", ordre: 6 },
  { slug: "education", label: "Éducation & Jeunesse", emoji: "🎓", ordre: 7 },
  { slug: "pouvoir-achat", label: "Pouvoir d'achat", emoji: "🛒", ordre: 8 },
  { slug: "institutions", label: "Institutions & Démocratie", emoji: "🏛️", ordre: 9 },
  { slug: "international", label: "International & Europe", emoji: "🌍", ordre: 10 },
];

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Seeding dim_theme...\n");

  const { data, error } = await supabase
    .from("dim_theme")
    .upsert(THEMES, {
      onConflict: "slug",         // Si le thème existe déjà → mise à jour
      ignoreDuplicates: false,    // On veut les mises à jour (label, emoji, ordre)
    })
    .select();

  if (error) {
    console.error("Erreur Supabase :", error.message);
    console.error("Code :", error.code);
    console.error("Détail :", error.details);
    process.exit(1);
  }

  console.log(`${data?.length} thèmes insérés / mis à jour :\n`);
  data?.forEach((t) =>
    console.log(`   ${t.emoji}  [${String(t.ordre).padStart(2, "0")}] ${t.slug.padEnd(15)} → ${t.label}`)
  );
  console.log("\n dim_theme est prêt. Tu peux lancer 01-fetch-deputes.ts");
}

main().catch((err) => {
  console.error("Erreur inattendue :", err);
  process.exit(1);
});
