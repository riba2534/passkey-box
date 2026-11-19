# Runtime image for a prebuilt static binary (see deploy.sh). Building FROM scratch
# on the server needs no base-image pull.
FROM scratch
COPY passkey-box /passkey-box
COPY passkey-box-extension.zip /srv/passkey-box-extension.zip
ENV PKB_LISTEN=:8080 \
    PKB_DB=/data/passkey-box.db \
    PKB_EXTENSION_ZIP=/srv/passkey-box-extension.zip \
    TMPDIR=/data
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/passkey-box"]
