# Build context: the server/ directory.
#   docker build -t passkey-box --build-arg VERSION=0.1.0 server
ARG GO_VERSION=1.26

FROM golang:${GO_VERSION} AS build
WORKDIR /src
ARG GOPROXY
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/passkey-box ./cmd/passkey-box \
    && mkdir -p /out/data

FROM scratch
COPY --from=build /out/passkey-box /passkey-box
COPY --from=build --chown=65532:65532 /out/data /data
ENV PKB_LISTEN=:8080 \
    PKB_DB=/data/passkey-box.db
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/passkey-box"]
