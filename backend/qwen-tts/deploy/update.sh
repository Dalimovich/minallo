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

required=(TTS_DOMAIN ACME_EMAIL QWEN_TTS_INTERNAL_SECRET)
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
"${COMPOSE[@]}" build --pull tts
"${COMPOSE[@]}" up -d --remove-orphans

DOMAIN="$(sed -n 's/^TTS_DOMAIN=//p' .env | tail -1 | tr -d '\r')"
echo "Waiting for https://${DOMAIN}/health ..."
# Model load can take minutes on first boot (weights download + warm-up),
# so poll far longer than python-ai's update.sh does before declaring failure.
healthy=false
for _ in {1..90}; do
  if curl --fail --silent --show-error --max-time 10 "https://${DOMAIN}/health" | grep -q '"ready":true'; then
    healthy=true
    break
  fi
  sleep 10
done

if [[ "$healthy" != true ]]; then
  echo "Deployment health check failed (model never reported ready)." >&2
  "${COMPOSE[@]}" logs --tail=150 tts caddy >&2
  if [[ -n "$PREVIOUS_TAG" ]] && docker image inspect "minallo-qwen-tts:${PREVIOUS_TAG}" >/dev/null 2>&1; then
    echo "Rolling back to ${PREVIOUS_TAG}." >&2
    export DEPLOY_TAG="$PREVIOUS_TAG"
    "${COMPOSE[@]}" up -d --no-build tts
  fi
  exit 1
fi

printf '%s\n' "$DEPLOY_TAG" >"$CURRENT_TAG_FILE"
chmod 600 "$CURRENT_TAG_FILE"
docker image prune -f --filter "until=168h" >/dev/null
echo "Deployed revision ${DEPLOY_TAG} successfully."
