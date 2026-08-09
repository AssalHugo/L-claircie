-- ============================================================
-- Authentification de l'interface d'administration
--
-- CONSTAT CORRIGÉ ICI : la route /admin n'avait aucune authentification, et
-- ses Server Actions utilisent SUPABASE_SERVICE_ROLE_KEY, qui possède
-- BYPASSRLS. N'importe qui connaissant l'URL pouvait valider ou retirer des
-- promesses en production. La RLS ne pouvait rien y faire : c'est précisément
-- le rôle de service qui est censé la contourner.
--
-- Cette migration pose la SOURCE D'AUTORISATION. Le contrôle d'accès lui-même
-- est applicatif (middleware Next.js + vérification dans chaque Server Action).
--
-- CHOIX : une table plutôt qu'une variable d'environnement.
--   • la liste des administrateurs est auditable et versionnée dans la base ;
--   • y ajouter ou en retirer quelqu'un ne demande pas de redéploiement ;
--   • la vérification est soumise à la RLS, donc démontrable par un test.
--
-- Migration idempotente : rejouable sans effet de bord.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "admin_utilisateur" (
  "user_id"  uuid PRIMARY KEY,
  "email"    varchar(320) NOT NULL,
  "nom"      varchar(200),
  "actif"    boolean NOT NULL DEFAULT true,
  "cree_le"  timestamptz NOT NULL DEFAULT (now())
);

COMMENT ON TABLE "admin_utilisateur" IS
  'Administrateurs autorisés à valider les promesses et les classifications. '
  'Référence logique vers auth.users(id) — pas de FK physique, par cohérence avec '
  'user_alertes et pour éviter les complications de restauration du schéma auth.';
COMMENT ON COLUMN "admin_utilisateur"."user_id" IS
  'auth.users(id) de Supabase. L''utilisateur doit exister avant d''être ajouté ici.';
COMMENT ON COLUMN "admin_utilisateur"."actif" IS
  'false = accès révoqué sans perdre la trace de qui a été administrateur.';

CREATE INDEX IF NOT EXISTS "idx_admin_actif" ON "admin_utilisateur" ("actif");

-- ────────────────────────────────────────────────────────────
-- RLS : un administrateur peut vérifier SA PROPRE appartenance,
-- et rien d'autre. La liste complète n'est lisible que par service_role.
--
-- C'est ce qui permet au serveur Next.js de faire le contrôle avec la session
-- de l'utilisateur (donc soumis à la RLS) plutôt qu'avec la clé de service.
-- ────────────────────────────────────────────────────────────

ALTER TABLE "admin_utilisateur" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "admin_utilisateur" FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "admin_utilisateur" FROM anon, authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $pol$
      DROP POLICY IF EXISTS "lecture_de_sa_propre_ligne" ON "admin_utilisateur";
      CREATE POLICY "lecture_de_sa_propre_ligne" ON "admin_utilisateur"
        FOR SELECT TO authenticated
        USING (auth.uid() = "user_id" AND "actif" = true);
    $pol$;
  ELSE
    RAISE NOTICE
      'Schéma auth absent : politique admin_utilisateur non créée. '
      'RLS reste actif sans politique, donc accès refusé (comportement sûr).';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- Amorçage
--
-- Le premier administrateur ne peut pas se créer lui-même — sinon la porte
-- serait ouverte. Procédure manuelle, une seule fois :
--
--   1. Tableau de bord Supabase → Authentication → Users → Add user
--      (renseigner un mot de passe ; NE PAS activer l'inscription publique)
--   2. Récupérer l'UUID de l'utilisateur créé, puis :
--
--        INSERT INTO admin_utilisateur (user_id, email, nom)
--        VALUES ('<uuid-copié>', 'vous@exemple.fr', 'Votre nom');
--
-- Pour révoquer un accès sans perdre la trace :
--   UPDATE admin_utilisateur SET actif = false WHERE email = '...';
-- ────────────────────────────────────────────────────────────

COMMIT;
