#!/usr/bin/env bash
# Deploys ECHO's backend to a hosted Supabase project.
# Requires: SUPABASE_ACCESS_TOKEN (personal access token) and SUPABASE_PROJECT_REF in the environment,
# plus SUPABASE_DB_PASSWORD for `db push`. Server secrets are read from supabase/functions/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF (the xxxx in https://xxxx.supabase.co)}"
: "${SUPABASE_ACCESS_TOKEN:?Create one at https://supabase.com/dashboard/account/tokens}"

npx supabase link --project-ref "$SUPABASE_PROJECT_REF" ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
echo "→ Applying database migrations"
npx supabase db push ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}

if [ -f supabase/functions/.env ]; then
  echo "→ Setting Edge Function secrets (non-empty values only)"
  tmp=$(mktemp)
  grep -E '^[A-Z_]+=.+' supabase/functions/.env | grep -v -E '^(SUPABASE_|DENO_|SSL_CERT_FILE)' > "$tmp" || true
  if [ -s "$tmp" ]; then npx supabase secrets set --env-file "$tmp"; fi
  rm -f "$tmp"
fi

echo "→ Deploying Edge Functions"
for fn in discover chat feedback profile catalog account spotify health; do
  npx supabase functions deploy "$fn" --no-verify-jwt
done
echo "✓ Backend deployed. Health: https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/health"
