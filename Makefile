.PHONY: test test-server test-extension build build-server build-extension zip-extension e2e run deploy

VERSION ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo dev)
PKB_DEFAULT_SERVER_URL ?=

test: test-server test-extension

test-server:
	cd server && go vet ./... && go test ./...

test-extension:
	cd extension && npm ci && npm run typecheck && npm test

build: build-server build-extension

build-server:
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/passkey-box ./cmd/passkey-box

build-extension:
	cd extension && npm ci && PKB_DEFAULT_SERVER_URL=$(PKB_DEFAULT_SERVER_URL) npm run build

zip-extension: build-extension
	mkdir -p dist && rm -f dist/passkey-box-extension.zip && cd extension/dist && zip -qr ../../dist/passkey-box-extension.zip .

e2e:
	cd e2e && npm ci && npx playwright test

# Local server with an admin account: http://127.0.0.1:8080 (admin / admin)
run: build-server zip-extension
	PKB_ADMIN_USERNAME=admin PKB_ADMIN_PASSWORD=admin PKB_LISTEN=127.0.0.1:8080 \
	PKB_DB=./data/passkey-box.db PKB_EXTENSION_ZIP=./dist/passkey-box-extension.zip ./dist/passkey-box

deploy:
	./deploy/deploy.sh
