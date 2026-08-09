import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/session";

export interface AdminConnecte {
    userId: string;
    email: string;
    nom: string | null;
}

/**
 * Résout l'administrateur connecté, ou `null`.
 *
 * Deux vérifications distinctes, dans cet ordre :
 *   1. AUTHENTIFICATION — `getUser()` interroge le serveur Supabase et valide
 *      le JWT. Ne jamais se fier à `getSession()` côté serveur : elle lit le
 *      cookie sans le vérifier, donc un cookie forgé passerait.
 *   2. AUTORISATION — appartenance à `admin_utilisateur`, lue AVEC LA SESSION
 *      de l'utilisateur. La politique RLS ne laisse voir que sa propre ligne
 *      active : si la requête renvoie une ligne, l'autorisation est prouvée
 *      par la base, pas par le code applicatif.
 */
export async function getAdminConnecte(): Promise<AdminConnecte | null> {
    const supabase = await createSessionClient();

    const { data: { user }, error: erreurAuth } = await supabase.auth.getUser();
    if (erreurAuth || !user) return null;

    const { data: admin } = await supabase
        .from("admin_utilisateur")
        .select("user_id, email, nom")
        .eq("user_id", user.id)
        .maybeSingle();

    if (!admin) return null;

    return {
        userId: admin.user_id as string,
        email: (admin.email as string) ?? user.email ?? "",
        nom: (admin.nom as string | null) ?? null,
    };
}

/**
 * Exige un administrateur connecté, sinon renvoie vers la page de connexion.
 *
 * À appeler au début de CHAQUE page d'administration ET de CHAQUE Server Action.
 *
 * ⚠️ Le middleware ne suffit pas. Une Server Action est un point d'entrée HTTP
 *    à part entière : elle doit porter sa propre vérification, sans quoi elle
 *    reste appelable directement. Le middleware n'est qu'une première barrière
 *    qui évite d'afficher l'interface — pas le contrôle d'accès lui-même.
 */
export async function requireAdmin(): Promise<AdminConnecte> {
    const admin = await getAdminConnecte();
    if (!admin) {
        redirect("/admin/login?erreur=acces_refuse");
    }
    return admin;
}
