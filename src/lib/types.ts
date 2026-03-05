// Types pour la page admin promesses

export interface Promesse {
    id: number;
    groupe_id: number;
    theme_id: number;
    intitule_court: string;
    description_longue: string | null;
    source_pdf_nom: string;
    source_pdf_page: number;
    source_citation: string;
    statut: string | null;
    statut_raison: string | null;
    created_at: string;
    // Jointures
    dim_groupe: {
        sigle: string;
        nom_complet: string;
        couleur_hex: string;
    };
    dim_theme: {
        slug: string;
        label: string;
        emoji: string | null;
    };
}

export interface Groupe {
    id: number;
    sigle: string;
    nom_complet: string;
    couleur_hex: string;
}

export interface Theme {
    id: number;
    slug: string;
    label: string;
    emoji: string | null;
}

// Valeurs possibles pour le statut (= statut_validation)
export const STATUT_OPTIONS = [
    { value: "all", label: "Tous les statuts" },
    { value: "null", label: "⏳ Non évalué" },
    { value: "auto", label: "✅ Auto-validé" },
    { value: "review", label: "⚠️ À relire" },
    { value: "valide", label: "✔️ Validé" },
    { value: "retiree", label: "🗑️ Retiré" },
] as const;

// Couleur du badge selon le statut
export function getStatutBadgeVariant(statut: string | null): "default" | "secondary" | "destructive" | "outline" {
    switch (statut) {
        case "auto":
            return "secondary";
        case "review":
            return "destructive";
        case "valide":
            return "default";
        case "retiree":
            return "outline";
        default:
            return "outline";
    }
}

// Promesse regroupée — une seule ligne pour les promesses partagées entre plusieurs groupes
export interface PromesseGroupee extends Promesse {
    sibling_ids: number[];
    all_groupes: { sigle: string; couleur_hex: string }[];
}

export function getStatutLabel(statut: string | null): string {
    switch (statut) {
        case "auto":
            return "Auto-validé";
        case "review":
            return "À relire";
        case "valide":
            return "Validé";
        case "retiree":
            return "Retiré";
        case null:
        case undefined:
            return "Non évalué";
        default:
            return statut;
    }
}
