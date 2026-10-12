# The installation's certificate tool (the install-core design, *TLS inside the stack*): openssl in a
# small image, since none of the stack's images carries it, and the owner's scripts need only a shell
# and Docker. bin/galatea-certs builds it as galatea-certs:local and runs it once per call, as the
# owner's account, with the CA's key, the servers' keys and tls/ bound in; nothing else mounts the
# CA's key.
FROM alpine:3
RUN apk add --no-cache openssl
COPY certs.sh /usr/local/bin/galatea-certs
ENTRYPOINT ["/usr/local/bin/galatea-certs"]
