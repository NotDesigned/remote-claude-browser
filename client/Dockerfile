# The SSH tunnel from the entry host to the server's gateway.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk add --no-cache openssh-client-default

COPY tunnel.sh /usr/local/bin/tunnel.sh
RUN chmod 0755 /usr/local/bin/tunnel.sh

EXPOSE 3010
ENTRYPOINT ["/usr/local/bin/tunnel.sh"]
