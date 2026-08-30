#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose --project-directory . --env-file .env)
CURRENT_TAG_FILE=".deploy-current"
PREVIOUS_TAG=""

if [[ ! -f .env ]]; then
  echo "Missing $(pwd)/.env. Copy .env.example and add production secrets." >&2
  exit 1
fi

chmod 600 .env

required=(AI_DOMAIN ACME_EMAIL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY INTERNAL_SECRET)
for key in "${required[@]}"; do
  if ! grep -Eq "^${key}=.+" .env; then
    echo "Missing required value: ${key}" >&2
    exit 1
  fi
done

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have local changes; refusing to overwrite them." >&2
  exit 1
fi

if [[ -f "$CURRENT_TAG_FILE" ]]; then
  PREVIOUS_TAG="$(<"$CURRENT_TAG_FILE")"
fi

git fetch --prune origin
git pull --ff-only

DEPLOY_TAG="$(git rev-parse --short=12 HEAD)"
export DEPLOY_TAG
export MINALLO_REVISION="$DEPLOY_TAG"

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build --pull api
"${COMPOSE[@]}" up -d --remove-orphans

DOMAIN="$(sed -n 's/^AI_DOMAIN=//p' .env | tail -1 | tr -d '\r')"
echo "Waiting for https://${DOMAIN}/health ..."
healthy=false
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 10 "https://${DOMAIN}/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  echo "Deployment health check failed." >&2
  "${COMPOSE[@]}" logs --tail=100 api caddy >&2
  if [[ -n "$PREVIOUS_TAG" ]] && docker image inspect "minallo-ai:${PREVIOUS_TAG}" >/dev/null 2>&1; then
    echo "Rolling back to ${PREVIOUS_TAG}." >&2
    export DEPLOY_TAG="$PREVIOUS_TAG"
    "${COMPOSE[@]}" up -d --no-build api
  fi
  exit 1
fi

printf '%s\n' "$DEPLOY_TAG" >"$CURRENT_TAG_FILE"
chmod 600 "$CURRENT_TAG_FILE"
docker image prune -f --filter "until=168h" >/dev/null
echo "Deployed revision ${DEPLOY_TAG} successfully."
