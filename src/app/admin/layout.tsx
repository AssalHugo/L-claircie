import Link from "next/link";

export default function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100">
            {/* Barre de navigation admin */}
            <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center gap-8">
                            <Link
                                href="/admin"
                                className="text-lg font-semibold bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent"
                            >
                                ☀️ L&apos;Éclaircie — Admin
                            </Link>
                            <nav className="flex gap-1">
                                <Link
                                    href="/admin/promesses"
                                    className="px-3 py-2 rounded-md text-sm font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
                                >
                                    Promesses
                                </Link>
                                <Link
                                    href="/admin/classifications"
                                    className="px-3 py-2 rounded-md text-sm font-medium text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors cursor-not-allowed"
                                    aria-disabled="true"
                                >
                                    Classifications
                                </Link>
                                <Link
                                    href="/admin/scrutins"
                                    className="px-3 py-2 rounded-md text-sm font-medium text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors cursor-not-allowed"
                                    aria-disabled="true"
                                >
                                    Scrutins
                                </Link>
                            </nav>
                        </div>
                    </div>
                </div>
            </header>

            {/* Contenu principal */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {children}
            </main>
        </div>
    );
}
