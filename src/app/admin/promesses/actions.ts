"use server";

import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/admin";
import { revalidatePath } from "next/cache";

/**
 * ⚠️ Chaque action commence par requireAdmin().
 *
 * Une Server Action est un point d'entrée HTTP à part entière : elle reste
 * appelable directement, sans passer par l'interface. Le middleware qui protège
 * /admin ne la couvre donc pas de façon fiable — et ces actions écrivent avec la
 * clé de service, qui contourne la RLS. La vérification doit être ici.
 */

// Valider une ou plusieurs promesses (statut → 'valide')
export async function validerPromesse(ids: number[]) {
    await requireAdmin();
    const supabase = createServerClient();

    const { error } = await supabase
        .from("dim_promesse")
        .update({ statut: "valide" })
        .in("id", ids);

    if (error) {
        return { success: false, error: error.message };
    }

    revalidatePath("/admin/promesses");
    return { success: true };
}

// Retirer une ou plusieurs promesses (statut → 'retiree')
export async function retirerPromesse(ids: number[]) {
    await requireAdmin();
    const supabase = createServerClient();

    const { error } = await supabase
        .from("dim_promesse")
        .update({ statut: "retiree" })
        .in("id", ids);

    if (error) {
        return { success: false, error: error.message };
    }

    revalidatePath("/admin/promesses");
    return { success: true };
}

// Modifier une ou plusieurs promesses (intitulé + description)
export async function modifierPromesse(
    ids: number[],
    data: { intitule_court: string; description_longue: string | null }
) {
    await requireAdmin();
    const supabase = createServerClient();

    const { error } = await supabase
        .from("dim_promesse")
        .update({
            intitule_court: data.intitule_court,
            description_longue: data.description_longue,
        })
        .in("id", ids);

    if (error) {
        return { success: false, error: error.message };
    }

    revalidatePath("/admin/promesses");
    return { success: true };
}
