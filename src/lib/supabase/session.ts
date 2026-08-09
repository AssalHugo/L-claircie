import { createServerClient as createSsrClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Client Supabase porteur de la SESSION de l'utilisateur connecté.
 *
 * À ne pas confondre avec `createServerClient()` de ./server.ts, qui utilise la
 * clé de service et contourne la RLS. Ici on utilise la clé publique : toutes
 * les requêtes restent soumises aux politiques RLS, ce qui rend le contrôle
 * d'accès démontrable plutôt que déclaratif.
 *
 * Réservé aux Server Components et Server Actions (accès aux cookies).
 */
export async function createSessionClient() {
    const cookieStore = await cookies();

    return createSsrClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        for (const { name, value, options } of cookiesToSet) {
                            cookieStore.set(name, value, options);
                        }
                    } catch {
                        // Appelé depuis un Server Component : l'écriture de cookies y est
                        // interdite. Le rafraîchissement de session est assuré par le
                        // middleware, cette erreur est donc sans conséquence.
                    }
                },
            },
        },
    );
}
