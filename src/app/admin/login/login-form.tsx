"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { connecter, type EtatConnexion } from "./actions";

const ETAT_INITIAL: EtatConnexion = { erreur: null };

function BoutonConnexion() {
    const { pending } = useFormStatus();
    return (
        <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-amber-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
            {pending ? "Connexion…" : "Se connecter"}
        </button>
    );
}

export function LoginForm({
    suite,
    erreurInitiale,
}: {
    suite: string;
    erreurInitiale: string | null;
}) {
    const [etat, action] = useActionState(connecter, {
        ...ETAT_INITIAL,
        erreur: erreurInitiale,
    });

    return (
        <form action={action} className="space-y-4">
            <input type="hidden" name="suite" value={suite} />

            <div className="space-y-1.5">
                <label htmlFor="email" className="block text-sm font-medium text-zinc-300">
                    Adresse e-mail
                </label>
                <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-amber-500"
                    placeholder="vous@exemple.fr"
                />
            </div>

            <div className="space-y-1.5">
                <label htmlFor="motDePasse" className="block text-sm font-medium text-zinc-300">
                    Mot de passe
                </label>
                <input
                    id="motDePasse"
                    name="motDePasse"
                    type="password"
                    autoComplete="current-password"
                    required
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500"
                />
            </div>

            {etat.erreur && (
                <p
                    role="alert"
                    className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
                >
                    {etat.erreur}
                </p>
            )}

            <BoutonConnexion />
        </form>
    );
}
