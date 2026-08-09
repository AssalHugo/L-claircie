import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware d'accès à /admin.
 *
 * Deux rôles :
 *   1. rafraîchir le cookie de session Supabase (les Server Components ne
 *      peuvent pas écrire de cookies, c'est donc ici que ça se joue) ;
 *   2. renvoyer vers la page de connexion un visiteur non authentifié.
 *
 * ⚠️ Ce middleware est une commodité, PAS le contrôle d'accès. L'autorisation
 *    réelle est vérifiée dans le layout et dans chaque Server Action via
 *    requireAdmin(). Un middleware Next.js a déjà été contourné par le passé
 *    (CVE-2025-29927) : il ne doit jamais être l'unique barrière.
 */
export async function middleware(request: NextRequest) {
    let response = NextResponse.next({ request });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    for (const { name, value } of cookiesToSet) {
                        request.cookies.set(name, value);
                    }
                    response = NextResponse.next({ request });
                    for (const { name, value, options } of cookiesToSet) {
                        response.cookies.set(name, value, options);
                    }
                },
            },
        },
    );

    // getUser() valide le JWT auprès de Supabase — contrairement à getSession(),
    // qui se contente de lire le cookie.
    const { data: { user } } = await supabase.auth.getUser();

    const chemin = request.nextUrl.pathname;
    const estPageConnexion = chemin.startsWith("/admin/login");

    if (!user && !estPageConnexion) {
        const url = request.nextUrl.clone();
        url.pathname = "/admin/login";
        url.search = "";
        url.searchParams.set("suite", chemin);
        return NextResponse.redirect(url);
    }

    // Déjà connecté : inutile de réafficher le formulaire.
    if (user && estPageConnexion) {
        const url = request.nextUrl.clone();
        url.pathname = "/admin";
        url.search = "";
        return NextResponse.redirect(url);
    }

    return response;
}

export const config = {
    matcher: ["/admin/:path*"],
};
