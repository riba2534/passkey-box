#!/usr/bin/env bash
# Build locally and deploy to a Docker host behind Caddy.
#
#   DEPLOY_HOST=ubuntu@1.2.3.4 SSH_KEY=~/.ssh/id_ed25519 ./deploy/deploy.sh
#
# Remote layout ($DEPLOY_DIR, default /home/ubuntu/software/passkey-box):
#   passkey-box.env   PKB_ADMIN_USERNAME / PKB_ADMIN_PASSWORD / PKB_COOKIE_SECURE ... (created once, never overwritten)
#   data/             SQLite database, owned by 65532:65532
#   build/            image build context (binary + extension zip + Dockerfile)
# The container listens on 127.0.0.1:$HOST_PORT; the reverse proxy terminates TLS.
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@1.2.3.4}"
DEPLOY_DIR=${DEPLOY_DIR:-/home/ubuntu/software/passkey-box}
HOST_PORT=${HOST_PORT:-18300}
PUBLIC_URL=${PUBLIC_URL:-https://password.riba2534.cn}
SSH_KEY=${SSH_KEY:-}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${VERSION:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}
OUT=$(mktemp -d /tmp/passkey-box-deploy.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ssh_cmd() {
  if [ -n "$SSH_KEY" ]; then
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes "$DEPLOY_HOST" "$@"
  else
    ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"
  fi
}

echo "==> building server $VERSION"
(cd "$ROOT/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.version=$VERSION" -o "$OUT/passkey-box" ./cmd/passkey-box)

echo "==> building extension (default server $PUBLIC_URL)"
(cd "$ROOT/extension" && npm ci --silent && PKB_DEFAULT_SERVER_URL="$PUBLIC_URL" npm run build --silent)
(cd "$ROOT/extension/dist" && zip -qr "$OUT/passkey-box-extension.zip" .)
cp "$ROOT/deploy/Dockerfile" "$OUT/Dockerfile"

echo "==> uploading to $DEPLOY_HOST:$DEPLOY_DIR"
ssh_cmd "mkdir -p '$DEPLOY_DIR/build' '$DEPLOY_DIR/data'"
tar -C "$OUT" -czf - passkey-box passkey-box-extension.zip Dockerfile | ssh_cmd "tar -C '$DEPLOY_DIR/build' -xzf -"

echo "==> building image and replacing container"
ssh_cmd "bash -s" <<REMOTE
set -euo pipefail
cd '$DEPLOY_DIR'
if [ ! -f passkey-box.env ]; then
  umask 077
  printf 'PKB_ADMIN_USERNAME=admin\nPKB_ADMIN_PASSWORD=%s\nPKB_COOKIE_SECURE=true\nPKB_ALLOW_REGISTER=false\n' "\$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" > passkey-box.env
  echo "created passkey-box.env with a random admin password"
fi
sudo chown -R 65532:65532 data
docker build -q -t passkey-box:'$VERSION' build >/dev/null
docker tag passkey-box:'$VERSION' passkey-box:current
if docker container inspect passkey-box >/dev/null 2>&1; then
  docker rm -f passkey-box-prev >/dev/null 2>&1 || true
  docker stop passkey-box >/dev/null
  docker rename passkey-box passkey-box-prev
fi
docker run -d --name passkey-box --restart unless-stopped \
  --security-opt no-new-privileges:true \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:$HOST_PORT:8080 \
  --env-file passkey-box.env \
  --mount type=bind,source='$DEPLOY_DIR/data',target=/data \
  passkey-box:'$VERSION' >/dev/null
for i in \$(seq 1 30); do
  if curl -fsS http://127.0.0.1:$HOST_PORT/healthz; then echo; exit 0; fi
  sleep 1
done
echo "health check failed" >&2
docker logs --tail 50 passkey-box >&2
exit 1
REMOTE
echo "==> deployed $VERSION; rollback: docker rm -f passkey-box && docker rename passkey-box-prev passkey-box && docker start passkey-box"
