-- ============================================================
-- Baseline — réaligner civic_tech.sql sur le schéma réellement utilisé
--
-- `civic_tech.sql` a divergé du code : plusieurs colonnes et contraintes
-- utilisées par les scripts d'ingestion n'y figurent pas. Conséquence, un tiers
-- qui reconstruit la base depuis le dépôt n'obtient PAS le schéma de production
-- et ne peut donc pas refaire le calcul des scores — ce qui contredit
-- frontalement l'objectif de vérifiabilité du projet.
--
-- Écarts corrigés ici :
--   1. dim_promesse.dedupe_hash        — écrit par 02-extract-promesses.ts
--   2. dim_promesse.source_pdf_annee   — écrit par 02-extract-promesses.ts
--   3. dim_promesse.statut NOT NULL    — 02 insère NULL, 03 filtre sur NULL
--
-- Toutes les opérations sont conditionnelles : cette migration est un no-op
-- sur une base de production où ces colonnes existent déjà.
-- ============================================================

BEGIN;

ALTER TABLE "dim_promesse"
  ADD COLUMN IF NOT EXISTS "dedupe_hash"      char(64),
  ADD COLUMN IF NOT EXISTS "source_pdf_annee" smallint;

COMMENT ON COLUMN "dim_promesse"."dedupe_hash" IS
  'SHA-256 de groupe_id || source_citation. Clé de dédoublonnage historique, propre à un groupe. '
  'Voir dedupe_hash_canonique pour la déduplication INTER-groupes des programmes communs.';
COMMENT ON COLUMN "dim_promesse"."source_pdf_annee" IS
  'Année du document source, ex: 2024. Déduite du nom de fichier ou de partage.json.';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_promesse_dedupe"
  ON "dim_promesse" ("dedupe_hash") WHERE "dedupe_hash" IS NOT NULL;

-- `statut` doit accepter NULL : 02-extract-promesses.ts insère les promesses
-- sans statut, et 03-review-promesses.ts sélectionne précisément celles-là
-- (`.is("statut", null)`) pour les soumettre à la relecture automatique.
ALTER TABLE "dim_promesse" ALTER COLUMN "statut" DROP NOT NULL;
ALTER TABLE "dim_promesse" ALTER COLUMN "statut" DROP DEFAULT;

COMMIT;
