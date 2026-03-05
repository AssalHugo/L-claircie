import { createClient } from "@supabase/supabase-js";

// Client Supabase côté serveur avec service_role key
// Utilisé dans les Server Components et Server Actions
export function createServerClient() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    return createClient(supabaseUrl, supabaseServiceKey);
}
