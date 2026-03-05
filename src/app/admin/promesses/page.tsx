import { createServerClient } from "@/lib/supabase/server";
import { PromessesTable } from "./promesses-table";
import type { Groupe, Theme, Promesse, PromesseGroupee } from "@/lib/types";

interface PageProps {
    searchParams: Promise<{
        statut?: string;
        groupe?: string;
        theme?: string;
    }>;
}

/**
 * Regroupe les promesses identiques (même intitulé + même citation)
 * en une seule entrée avec la liste de tous les groupes et IDs sœurs.
 */
function grouperPromesses(promesses: Promesse[]): PromesseGroupee[] {
    const map = new Map<string, PromesseGroupee>();

    for (const p of promesses) {
        const key = `${p.intitule_court}|||${p.source_citation}`;
        const existing = map.get(key);

        if (existing) {
            existing.sibling_ids.push(p.id);
            // Éviter les doublons de groupe (si même groupe apparaît 2x)
            if (!existing.all_groupes.some((g) => g.sigle === p.dim_groupe.sigle)) {
                existing.all_groupes.push({
                    sigle: p.dim_groupe.sigle,
                    couleur_hex: p.dim_groupe.couleur_hex,
                });
            }
        } else {
            map.set(key, {
                ...p,
                sibling_ids: [p.id],
                all_groupes: [
                    {
                        sigle: p.dim_groupe.sigle,
                        couleur_hex: p.dim_groupe.couleur_hex,
                    },
                ],
            });
        }
    }

    return Array.from(map.values());
}

export default async function PromessesPage({ searchParams }: PageProps) {
    const params = await searchParams;
    const supabase = createServerClient();

    // Récupérer les groupes et thèmes pour les filtres
    const [groupesRes, themesRes] = await Promise.all([
        supabase
            .from("dim_groupe")
            .select("id, sigle, nom_complet, couleur_hex")
            .eq("actif", true)
            .order("sigle"),
        supabase
            .from("dim_theme")
            .select("id, slug, label, emoji")
            .order("ordre"),
    ]);

    const groupes = (groupesRes.data ?? []) as Groupe[];
    const themes = (themesRes.data ?? []) as Theme[];

    // Construire la requête de promesses avec jointures
    let query = supabase
        .from("dim_promesse")
        .select(
            `
      id,
      groupe_id,
      theme_id,
      intitule_court,
      description_longue,
      source_pdf_nom,
      source_pdf_page,
      source_citation,
      statut,
      statut_raison,
      created_at,
      dim_groupe!inner (sigle, nom_complet, couleur_hex),
      dim_theme!inner (slug, label, emoji)
    `
        )
        .order("id", { ascending: true });

    // Filtre par statut (par défaut : 'review')
    const statutFilter = params.statut ?? "review";
    if (statutFilter !== "all") {
        if (statutFilter === "null") {
            query = query.is("statut", null);
        } else {
            query = query.eq("statut", statutFilter);
        }
    }

    // Filtre par groupe
    if (params.groupe && params.groupe !== "all") {
        const groupe = groupes.find((g) => g.sigle === params.groupe);
        if (groupe) {
            query = query.eq("groupe_id", groupe.id);
        }
    }

    // Filtre par thème
    if (params.theme && params.theme !== "all") {
        const theme = themes.find((t) => t.slug === params.theme);
        if (theme) {
            query = query.eq("theme_id", theme.id);
        }
    }

    const { data: promesses, error } = await query;

    if (error) {
        return (
            <div className="p-6 rounded-xl border border-red-800 bg-red-900/20">
                <h2 className="text-lg font-semibold text-red-400">
                    Erreur chargement
                </h2>
                <p className="text-sm text-red-300 mt-1">{error.message}</p>
            </div>
        );
    }

    // Regrouper les promesses identiques (contenu partagé entre groupes)
    const promessesGroupees = grouperPromesses(
        (promesses ?? []) as unknown as Promesse[]
    );

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">
                    📋 Gestion des promesses
                </h1>
                <p className="text-zinc-400 mt-1">
                    {promessesGroupees.length} promesse(s) unique(s) affichée(s)
                    {promessesGroupees.length !== (promesses?.length ?? 0) && (
                        <span className="text-zinc-500">
                            {" "}
                            ({(promesses?.length ?? 0)} lignes en base)
                        </span>
                    )}
                    {" "}— filtre par défaut :
                    <span className="text-amber-400 font-medium"> à relire</span>
                </p>
            </div>

            <PromessesTable
                promesses={promessesGroupees}
                groupes={groupes}
                themes={themes}
                currentStatut={statutFilter}
                currentGroupe={params.groupe ?? "all"}
                currentTheme={params.theme ?? "all"}
            />
        </div>
    );
}
