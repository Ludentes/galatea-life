#!/bin/sh
# Runs inside galatea-certs:local (bin/galatea-certs), as the owner's account:
#   issue    the CA once, then each server's certificate where it is missing, has 60 days or fewer
#            left, carries other names than the settings, or was not signed by the current CA
#   new-ca   a new CA, then every server's certificate again
#   check    each certificate's days left; exits 1 when one is missing or fails to verify
# Binds: /ca (secrets/ca: the CA's key), /keys (secrets/tls: the servers' keys), /tls (tls/: the CA's
# and the servers' certificates). GALATEA_TLS_NAMES: names or addresses every server certificate
# carries besides its Compose name, localhost and 127.0.0.1, separated by spaces or commas.
# Prints one line `issued <server>` per certificate it wrote, and `ca <made|kept>`.
set -eu

SERVERS="applier steward broker"
CA_DAYS=3650
SERVER_DAYS=730
RENEW_S=$((60 * 86400))
CA_KEY=/ca/ca.key
CA=/tls/ca.pem

fail() { echo "galatea-certs: $*" >&2; exit 1; }

# Keys are the owner's alone; certificates are for anyone to read.
umask 077

# The names a server's certificate carries, as openssl's subjectAltName setting.
san_of() {
  out="DNS:$1,DNS:localhost,IP:127.0.0.1"
  for n in $(echo "${GALATEA_TLS_NAMES:-}" | tr ',' ' '); do
    if echo "$n" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || echo "$n" | grep -q ':'; then
      out="$out,IP:$n"
    else
      echo "$n" | grep -Eq '^[A-Za-z0-9*]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || fail "not a host name or address: $n"
      out="$out,DNS:$n"
    fi
  done
  echo "$out"
}

# A subjectAltName as openssl prints it, its entries sorted, so two lists compare whatever their order.
san_printed() {
  sed -n '/Subject Alternative Name/{n;p;}' | tr -d ' ' | tr ',' '\n' | sort | tr '\n' ','
}

# What openssl would print for these settings: a throwaway request carries them.
san_wanted() {
  key=$(mktemp)
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key" 2>/dev/null
  openssl req -new -key "$key" -subj "/CN=$1" -addext "subjectAltName=$(san_of "$1")" 2>/dev/null |
    openssl req -noout -text | san_printed
  rm -f "$key"
}

san_held() {
  openssl x509 -in "$1" -noout -text | san_printed
}

make_ca() {
  conf=$(mktemp)
  cat >"$conf" <<CONF
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = Galatea installation CA
[ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CONF
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_KEY.new" 2>/dev/null
  (umask 022 && openssl req -x509 -new -key "$CA_KEY.new" -sha256 -days "$CA_DAYS" -config "$conf" -out "$CA.new")
  rm -f "$conf"
  chmod 600 "$CA_KEY.new"
  chmod 644 "$CA.new"
  # The key first: a CA certificate is never left beside a key it does not match.
  mv "$CA_KEY.new" "$CA_KEY"
  mv "$CA.new" "$CA"
}

# Why `$1`'s certificate must be issued again, or nothing.
stale() {
  cert=/tls/$1.pem
  [ -s "$cert" ] && [ -s "/keys/$1.key" ] || { echo missing; return; }
  openssl verify -CAfile "$CA" "$cert" >/dev/null 2>&1 || { echo "not signed by the current CA"; return; }
  openssl x509 -in "$cert" -noout -checkend "$RENEW_S" >/dev/null || { echo "60 days or fewer left"; return; }
  [ "$(san_held "$cert")" = "$(san_wanted "$1")" ] || { echo "its names differ from the settings"; return; }
}

issue() {
  conf=$(mktemp)
  cat >"$conf" <<CONF
[server]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = $(san_of "$1")
CONF
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "/keys/$1.key.new" 2>/dev/null
  csr=$(mktemp)
  openssl req -new -key "/keys/$1.key.new" -subj "/CN=$1" -out "$csr"
  (umask 022 && openssl x509 -req -in "$csr" -CA "$CA" -CAkey "$CA_KEY" -set_serial "0x$(openssl rand -hex 16)" \
    -sha256 -days "$SERVER_DAYS" -extfile "$conf" -extensions server -out "/tls/$1.pem.new" 2>/dev/null)
  rm -f "$conf" "$csr"
  chmod 600 "/keys/$1.key.new"
  chmod 644 "/tls/$1.pem.new"
  mv "/keys/$1.key.new" "/keys/$1.key"
  mv "/tls/$1.pem.new" "/tls/$1.pem"
}

days_left() {
  end=$(openssl x509 -in "$1" -noout -enddate -dateopt iso_8601 | cut -d= -f2)
  echo $((($(date -u -D '%Y-%m-%d %H:%M:%SZ' -d "$end" +%s) - $(date -u +%s)) / 86400))
}

for d in /ca /keys /tls; do [ -d "$d" ] && [ -w "$d" ] || fail "$d is not bound, or not writable by uid $(id -u)"; done

case "${1:-issue}" in
  issue)
    if [ -s "$CA_KEY" ] && [ -s "$CA" ]; then
      echo "ca kept"
    elif [ -e "$CA_KEY" ] || [ -e "$CA" ]; then
      fail "one of secrets/ca/ca.key and tls/ca.pem is there without the other; restore both, or make a new CA with --new-ca"
    else
      make_ca
      echo "ca made"
    fi
    for s in $SERVERS; do
      why=$(stale "$s")
      [ -n "$why" ] || continue
      issue "$s"
      echo "issued $s ($why)"
    done
    ;;
  new-ca)
    make_ca
    echo "ca made"
    for s in $SERVERS; do
      issue "$s"
      echo "issued $s (a new CA)"
    done
    ;;
  check)
    bad=0
    [ -s "$CA" ] || fail "no CA in tls/ca.pem: run bin/galatea-certs"
    echo "ca: $(days_left "$CA") days left"
    for s in $SERVERS; do
      if [ ! -s "/tls/$s.pem" ]; then
        echo "$s: missing"; bad=1
      elif ! openssl verify -CAfile "$CA" "/tls/$s.pem" >/dev/null 2>&1; then
        echo "$s: not signed by the current CA"; bad=1
      else
        why=$(stale "$s")
        echo "$s: $(days_left "/tls/$s.pem") days left${why:+, to be issued again: $why}"
      fi
    done
    exit "$bad"
    ;;
  *) fail "usage: galatea-certs [issue | new-ca | check]" ;;
esac
