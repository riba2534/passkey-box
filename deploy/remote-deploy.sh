#!/usr/bin/env bash
# Runs on the Docker host (deploy.sh pipes it over ssh). Builds the image from
# $DEPLOY_DIR/build, replaces the container and restores the previous one if the
# new container fails to start or to pass the health check.
#
#   remote-deploy.sh <deploy_dir> <version> <host_port> [container_name]
#
# Test knobs: SKIP_BUILD=1 uses $IMAGE as is, SKIP_CHOWN=1 leaves data/ ownership alone.
set -euo pipefail

DEPLOY_DIR=$1
VERSION=$2
HOST_PORT=$3
NAME=${4:-passkey-box}
IMAGE=${IMAGE:-passkey-box:$VERSION}

cd "$DEPLOY_DIR"
mkdir -p data
if [ ! -f passkey-box.env ]; then
  umask 077
  printf 'PKB_ADMIN_USERNAME=admin\nPKB_ADMIN_PASSWORD=%s\nPKB_COOKIE_SECURE=true\nPKB_ALLOW_REGISTER=false\n' \
    "$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" > passkey-box.env
  umask 022
  echo "created passkey-box.env with a random admin password"
fi
if [ -z "${SKIP_CHOWN:-}" ] && [ "$(stat -c %u data)" != 65532 ]; then sudo -n chown -R 65532:65532 data; fi

if [ -z "${SKIP_BUILD:-}" ]; then
  docker build -q -t "$IMAGE" build >/dev/null
  docker tag "$IMAGE" passkey-box:current
fi

rollback() {
  echo "deploy failed, rolling back" >&2
  docker logs --tail 50 "$NAME" >&2 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if docker container inspect "$NAME-prev" >/dev/null 2>&1; then
    docker rename "$NAME-prev" "$NAME"
    docker start "$NAME" >/dev/null
    echo "previous container restored" >&2
  fi
  exit 1
}

if docker container inspect "$NAME" >/dev/null 2>&1; then
  docker rm -f "$NAME-prev" >/dev/null 2>&1 || true
  docker stop "$NAME" >/dev/null
  docker rename "$NAME" "$NAME-prev"
fi

docker run -d --name "$NAME" --restart unless-stopped \
  --security-opt no-new-privileges:true \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p "127.0.0.1:$HOST_PORT:8080" \
  --env-file passkey-box.env \
  --mount "type=bind,source=$DEPLOY_DIR/data,target=/data" \
  "$IMAGE" >/dev/null || rollback

for _ in $(seq 1 "${HEALTH_TRIES:-30}"); do
  if curl -fsS "http://127.0.0.1:$HOST_PORT/healthz" 2>/dev/null; then echo; exit 0; fi
  sleep 1
done
rollback
