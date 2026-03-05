export default function AdminPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Dashboard Admin</h1>
                <p className="text-zinc-400 mt-1">
                    Bienvenue dans l&apos;interface d&apos;administration de L&apos;Éclaircie.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <a
                    href="/admin/promesses"
                    className="group p-6 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:border-amber-500/50 hover:bg-zinc-900 transition-all"
                >
                    <h2 className="text-lg font-semibold text-white group-hover:text-amber-400 transition-colors">
                        📋 Promesses
                    </h2>
                    <p className="text-sm text-zinc-400 mt-2">
                        Gérer les promesses extraites des programmes. Valider, modifier ou
                        retirer.
                    </p>
                </a>

                <div className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/30 opacity-50 cursor-not-allowed">
                    <h2 className="text-lg font-semibold text-zinc-500">
                        🤖 Classifications
                    </h2>
                    <p className="text-sm text-zinc-600 mt-2">
                        Valider les liens scrutin ↔ promesse produits par l&apos;IA. Bientôt
                        disponible.
                    </p>
                </div>

                <div className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/30 opacity-50 cursor-not-allowed">
                    <h2 className="text-lg font-semibold text-zinc-500">
                        🗳️ Scrutins
                    </h2>
                    <p className="text-sm text-zinc-600 mt-2">
                        Voir les derniers votes à l&apos;Assemblée nationale. Bientôt disponible.
                    </p>
                </div>
            </div>
        </div>
    );
}
