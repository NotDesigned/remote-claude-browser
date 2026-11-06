# The SSH tunnel from the entry host to the server's gateway.
FROM alpine:3.22

RUN apk add --no-cache openssh-client-default

COPY tunnel.sh /usr/local/bin/tunnel.sh
RUN chmod 0755 /usr/local/bin/tunnel.sh

EXPOSE 3010
ENTRYPOINT ["/usr/local/bin/tunnel.sh"]
