import { LoginForm } from "./login-form";

interface PageProps {
    searchParams: Promise<{ suite?: string; erreur?: string }>;
}

const MESSAGES: Record<string, string> = {
    acces_refuse: "Connectez-vous pour accéder à l'administration.",
};

export default async function LoginPage({ searchParams }: PageProps) {
    const params = await searchParams;
    const suite = params.suite?.startsWith("/admin") ? params.suite : "/admin";
    const erreurInitiale = params.erreur ? (MESSAGES[params.erreur] ?? null) : null;

    return (
        <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center">
            <div className="mb-8 text-center">
                <p className="bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-lg font-semibold text-transparent">
                    ☀️ L&apos;Éclaircie
                </p>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">
                    Administration
                </h1>
                <p className="mt-1 text-sm text-zinc-400">
                    Accès réservé aux comptes autorisés.
                </p>
            </div>

            <LoginForm suite={suite} erreurInitiale={erreurInitiale} />
        </div>
    );
}
