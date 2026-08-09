"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSessionClient } from "@/lib/supabase/session";
import { getAdminConnecte } from "@/lib/auth/admin";

export interface EtatConnexion {
    erreur: string | null;
}

/** Ne garde que les chemins internes : évite une redirection ouverte via ?suite= */
function destinationSure(suite: FormDataEntryValue | null): string {
    const valeur = typeof suite === "string" ? suite : "";
    if (valeur.startsWith("/admin") && !valeur.startsWith("/admin/login")) {
        return valeur;
    }
    return "/admin";
}

export async function connecter(
    _etatPrecedent: EtatConnexion,
    formData: FormData,
): Promise<EtatConnexion> {
    const email = String(formData.get("email") ?? "").trim();
    const motDePasse = String(formData.get("motDePasse") ?? "");

    if (!email || !motDePasse) {
        return { erreur: "Renseignez votre adresse e-mail et votre mot de passe." };
    }

    const supabase = await createSessionClient();
    const { error } = await supabase.auth.signInWithPassword({
        email,
        password: motDePasse,
    });

    // Message volontairement identique pour un e-mail inconnu et un mot de passe
    // faux : distinguer les deux révélerait quels comptes existent.
    if (error) {
        return { erreur: "Identifiants invalides." };
    }

    // Authentifié ne vaut pas autorisé : le compte doit figurer dans
    // admin_utilisateur. Sinon on referme la session immédiatement.
    const admin = await getAdminConnecte();
    if (!admin) {
        await supabase.auth.signOut();
        return {
            erreur: "Ce compte n'est pas autorisé à accéder à l'administration.",
        };
    }

    const destination = destinationSure(formData.get("suite"));
    revalidatePath("/admin", "layout");
    redirect(destination);
}

export async function deconnecter(): Promise<void> {
    const supabase = await createSessionClient();
    await supabase.auth.signOut();
    revalidatePath("/admin", "layout");
    redirect("/admin/login");
}
