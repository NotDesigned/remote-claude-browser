# The SSH tunnel from the entry host to the server's gateway.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

RUN apk add --no-cache openssh-client-default

COPY tunnel.sh /usr/local/bin/tunnel.sh
RUN chmod 0755 /usr/local/bin/tunnel.sh

EXPOSE 3010
ENTRYPOINT ["/usr/local/bin/tunnel.sh"]
