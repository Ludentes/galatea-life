# The install tests' Python check (certs.test.ts): run in python:3.13-alpine.
# A TLS handshake in one process: a server with the certificate and key, a client with Python's
# default context (3.13: VERIFY_X509_STRICT and VERIFY_X509_PARTIAL_CHAIN) trusting the CA alone.
import socket, ssl, sys, threading
cert, key, ca, name = sys.argv[1:5]
srv = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); srv.load_cert_chain(cert, key)
ls = socket.socket(); ls.bind(("127.0.0.1", 0)); ls.listen(1)
def serve():
    c, _ = ls.accept()
    try:
        with srv.wrap_socket(c, server_side=True) as s: s.recv(1)
    except Exception: pass
threading.Thread(target=serve, daemon=True).start()
cli = ssl.create_default_context(cafile=ca)
print("strict" if cli.verify_flags & ssl.VERIFY_X509_STRICT else "not strict")
with socket.create_connection(ls.getsockname()) as raw, cli.wrap_socket(raw, server_hostname=name) as s:
    print("verified", s.version())
