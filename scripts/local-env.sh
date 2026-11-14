#!/usr/bin/env bash
# Writes supabase/functions/.env.local with the local stack's URL/keys (for scripts/dev-functions.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
{
  grep -v -E '^(SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=' supabase/functions/.env 2>/dev/null || true
  echo "SUPABASE_URL=$API_URL"
  echo "SUPABASE_ANON_KEY=$ANON_KEY"
  echo "SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY"
} > supabase/functions/.env.local
echo "wrote supabase/functions/.env.local"
