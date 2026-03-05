import { createClient } from "@supabase/supabase-js";

// Client Supabase côté navigateur avec anon key
// Utilisé dans les composants client
export function createBrowserClient() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    return createClient(supabaseUrl, supabaseAnonKey);
}
