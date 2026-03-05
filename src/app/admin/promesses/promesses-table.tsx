"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { PromesseGroupee, Groupe, Theme } from "@/lib/types";
import {
    STATUT_OPTIONS,
    getStatutBadgeVariant,
    getStatutLabel,
} from "@/lib/types";
import {
    validerPromesse,
    retirerPromesse,
    modifierPromesse,
} from "./actions";

interface PromessesTableProps {
    promesses: PromesseGroupee[];
    groupes: Groupe[];
    themes: Theme[];
    currentStatut: string;
    currentGroupe: string;
    currentTheme: string;
}

export function PromessesTable({
    promesses,
    groupes,
    themes,
    currentStatut,
    currentGroupe,
    currentTheme,
}: PromessesTableProps) {
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();

    // État pour le dialog de modification
    const [editingPromesse, setEditingPromesse] =
        useState<PromesseGroupee | null>(null);
    const [editIntitule, setEditIntitule] = useState("");
    const [editDescription, setEditDescription] = useState("");

    // Construire l'URL avec les paramètres de filtre
    function updateFilter(key: string, value: string) {
        const params = new URLSearchParams();
        const current = {
            statut: currentStatut,
            groupe: currentGroupe,
            theme: currentTheme,
        };
        const updated = { ...current, [key]: value };

        if (updated.statut !== "review") params.set("statut", updated.statut);
        if (updated.groupe !== "all") params.set("groupe", updated.groupe);
        if (updated.theme !== "all") params.set("theme", updated.theme);

        const queryString = params.toString();
        router.push(queryString ? `${pathname}?${queryString}` : pathname);
    }

    // Actions — envoient tous les IDs sœurs
    async function handleValider(p: PromesseGroupee) {
        startTransition(async () => {
            const result = await validerPromesse(p.sibling_ids);
            if (result.success) {
                const n = p.sibling_ids.length;
                toast.success(
                    n > 1
                        ? `Promesse validée pour ${n} groupes ✅`
                        : "Promesse validée ✅"
                );
            } else {
                toast.error(`Erreur : ${result.error}`);
            }
        });
    }

    async function handleRetirer(p: PromesseGroupee) {
        startTransition(async () => {
            const result = await retirerPromesse(p.sibling_ids);
            if (result.success) {
                const n = p.sibling_ids.length;
                toast.success(
                    n > 1
                        ? `Promesse retirée pour ${n} groupes 🗑️`
                        : "Promesse retirée 🗑️"
                );
            } else {
                toast.error(`Erreur : ${result.error}`);
            }
        });
    }

    function handleEdit(promesse: PromesseGroupee) {
        setEditingPromesse(promesse);
        setEditIntitule(promesse.intitule_court);
        setEditDescription(promesse.description_longue ?? "");
    }

    async function handleSaveEdit() {
        if (!editingPromesse) return;
        startTransition(async () => {
            const result = await modifierPromesse(editingPromesse.sibling_ids, {
                intitule_court: editIntitule,
                description_longue: editDescription || null,
            });
            if (result.success) {
                const n = editingPromesse.sibling_ids.length;
                toast.success(
                    n > 1
                        ? `Promesse modifiée pour ${n} groupes ✏️`
                        : "Promesse modifiée ✏️"
                );
                setEditingPromesse(null);
            } else {
                toast.error(`Erreur : ${result.error}`);
            }
        });
    }

    return (
        <div className="space-y-4">
            {/* Barre de filtres */}
            <div className="flex flex-wrap gap-3 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                        Statut
                    </label>
                    <Select
                        value={currentStatut}
                        onValueChange={(v) => updateFilter("statut", v)}
                    >
                        <SelectTrigger className="w-[180px] bg-zinc-800 border-zinc-700">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STATUT_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                        Groupe
                    </label>
                    <Select
                        value={currentGroupe}
                        onValueChange={(v) => updateFilter("groupe", v)}
                    >
                        <SelectTrigger className="w-[180px] bg-zinc-800 border-zinc-700">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Tous les groupes</SelectItem>
                            {groupes.map((g) => (
                                <SelectItem key={g.id} value={g.sigle}>
                                    <span className="flex items-center gap-2">
                                        <span
                                            className="inline-block w-2.5 h-2.5 rounded-full"
                                            style={{
                                                backgroundColor: g.couleur_hex,
                                            }}
                                        />
                                        {g.sigle}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                        Thème
                    </label>
                    <Select
                        value={currentTheme}
                        onValueChange={(v) => updateFilter("theme", v)}
                    >
                        <SelectTrigger className="w-[200px] bg-zinc-800 border-zinc-700">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Tous les thèmes</SelectItem>
                            {themes.map((t) => (
                                <SelectItem key={t.id} value={t.slug}>
                                    {t.emoji} {t.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex items-end ml-auto">
                    <div className="text-sm text-zinc-500">
                        {promesses.length} résultat(s)
                    </div>
                </div>
            </div>

            {/* Table des promesses */}
            {promesses.length === 0 ? (
                <div className="text-center py-16 text-zinc-500">
                    <p className="text-lg">
                        Aucune promesse trouvée pour ces filtres.
                    </p>
                    <p className="text-sm mt-1">
                        Essayez de modifier les filtres ci-dessus.
                    </p>
                </div>
            ) : (
                <div className="rounded-xl border border-zinc-800 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 bg-zinc-900/80 hover:bg-zinc-900/80">
                                <TableHead className="text-zinc-400 w-12">
                                    #
                                </TableHead>
                                <TableHead className="text-zinc-400">
                                    Intitulé
                                </TableHead>
                                <TableHead className="text-zinc-400 w-40">
                                    Groupe(s)
                                </TableHead>
                                <TableHead className="text-zinc-400 w-40">
                                    Thème
                                </TableHead>
                                <TableHead className="text-zinc-400 w-28">
                                    Statut
                                </TableHead>
                                <TableHead className="text-zinc-400 min-w-[200px]">
                                    Raison
                                </TableHead>
                                <TableHead className="text-zinc-400 w-52 text-right">
                                    Actions
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {promesses.map((p) => (
                                <TableRow
                                    key={p.id}
                                    className="border-zinc-800 hover:bg-zinc-800/50 transition-colors"
                                >
                                    <TableCell className="font-mono text-xs text-zinc-500">
                                        {p.id}
                                    </TableCell>
                                    <TableCell>
                                        <div className="space-y-1">
                                            <p className="font-medium text-zinc-200 leading-snug">
                                                {p.intitule_court}
                                            </p>
                                            <p className="text-xs text-zinc-500 line-clamp-2 max-w-lg">
                                                «{" "}
                                                {p.source_citation.slice(
                                                    0,
                                                    150
                                                )}
                                                {p.source_citation.length > 150
                                                    ? "…"
                                                    : ""}{" "}
                                                »
                                            </p>
                                            <p className="text-[10px] text-zinc-600">
                                                📄 {p.source_pdf_nom} — p.
                                                {p.source_pdf_page}
                                            </p>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-wrap gap-1">
                                            {p.all_groupes.map((g) => (
                                                <Badge
                                                    key={g.sigle}
                                                    variant="outline"
                                                    className="border-current font-semibold text-xs"
                                                    style={{
                                                        color: g.couleur_hex,
                                                    }}
                                                >
                                                    {g.sigle}
                                                </Badge>
                                            ))}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <span className="text-sm">
                                            {p.dim_theme.emoji}{" "}
                                            {p.dim_theme.label}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <Badge
                                            variant={getStatutBadgeVariant(
                                                p.statut
                                            )}
                                        >
                                            {getStatutLabel(p.statut)}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        {p.statut_raison && (
                                            <div className="text-xs text-amber-200/80 bg-amber-900/10 p-2 rounded border border-amber-900/30 whitespace-pre-wrap">
                                                {p.statut_raison}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1.5">
                                            {p.statut !== "valide" && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        handleValider(p)
                                                    }
                                                    disabled={isPending}
                                                    className="h-7 px-2 text-xs border-emerald-700 text-emerald-400 hover:bg-emerald-900/30 hover:text-emerald-300"
                                                >
                                                    ✅ Valider
                                                    {p.all_groupes.length >
                                                        1 && (
                                                            <span className="ml-1 text-[10px] opacity-70">
                                                                ×
                                                                {
                                                                    p.all_groupes
                                                                        .length
                                                                }
                                                            </span>
                                                        )}
                                                </Button>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => handleEdit(p)}
                                                disabled={isPending}
                                                className="h-7 px-2 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                            >
                                                ✏️ Modifier
                                            </Button>
                                            {p.statut !== "retiree" && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        handleRetirer(p)
                                                    }
                                                    disabled={isPending}
                                                    className="h-7 px-2 text-xs border-red-800 text-red-400 hover:bg-red-900/30 hover:text-red-300"
                                                >
                                                    🗑️
                                                </Button>
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {/* Dialog de modification */}
            <Dialog
                open={!!editingPromesse}
                onOpenChange={(open) => !open && setEditingPromesse(null)}
            >
                <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>
                            Modifier la promesse #{editingPromesse?.id}
                            {editingPromesse &&
                                editingPromesse.all_groupes.length > 1 && (
                                    <span className="text-sm font-normal text-zinc-400 ml-2">
                                        ({editingPromesse.all_groupes.length}{" "}
                                        groupes)
                                    </span>
                                )}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label
                                htmlFor="edit-intitule"
                                className="text-zinc-300"
                            >
                                Intitulé court
                            </Label>
                            <Textarea
                                id="edit-intitule"
                                value={editIntitule}
                                onChange={(e) =>
                                    setEditIntitule(e.target.value)
                                }
                                className="bg-zinc-800 border-zinc-700 text-zinc-100 min-h-[80px]"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor="edit-description"
                                className="text-zinc-300"
                            >
                                Description longue
                            </Label>
                            <Textarea
                                id="edit-description"
                                value={editDescription}
                                onChange={(e) =>
                                    setEditDescription(e.target.value)
                                }
                                rows={4}
                                className="bg-zinc-800 border-zinc-700 text-zinc-100 min-h-[120px]"
                            />
                        </div>

                        {editingPromesse && (
                            <div className="p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                                    Citation source (lecture seule)
                                </p>
                                <p className="text-xs text-zinc-400 italic">
                                    « {editingPromesse.source_citation} »
                                </p>
                            </div>
                        )}

                        {editingPromesse &&
                            editingPromesse.all_groupes.length > 1 && (
                                <div className="p-3 rounded-lg bg-amber-900/10 border border-amber-900/30">
                                    <p className="text-xs text-amber-300">
                                        ⚠️ Cette modification s'appliquera aux{" "}
                                        {editingPromesse.all_groupes.length}{" "}
                                        groupes :{" "}
                                        {editingPromesse.all_groupes
                                            .map((g) => g.sigle)
                                            .join(", ")}
                                    </p>
                                </div>
                            )}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setEditingPromesse(null)}
                            className="border-zinc-700 text-zinc-300"
                        >
                            Annuler
                        </Button>
                        <Button
                            onClick={handleSaveEdit}
                            disabled={isPending || !editIntitule.trim()}
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                        >
                            {isPending ? "Enregistrement…" : "Enregistrer"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
