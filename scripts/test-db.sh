#!/usr/bin/env bash
# Resets the local database from migrations and runs the pgTAP RLS tests.
set -euo pipefail
cd "$(dirname "$0")/.."
npx supabase db reset
npx supabase test db
