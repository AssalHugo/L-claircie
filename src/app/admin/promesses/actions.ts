"use server";

import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// Valider une ou plusieurs promesses (statut → 'valide')
export async function validerPromesse(ids: number[]) {
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
