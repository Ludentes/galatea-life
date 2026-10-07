# A connection that outlives the process that opened it (reviews I1, N1): it connects to the private
# bus whose socket it is given and authenticates, hands the socket to a child and exits, so that the
# daemon keeps giving the parent's pid, now free, for a connection the child holds. Mode "hello" says
# Hello to the bus daemon before the fork (the review's P1: an old unique name); mode "late" only
# once the go file exists (the re-review's late Hello: a name newer than any taken before the
# helper's spawn). Once the go file exists, the child calls the helper endpoint's Hello with a token
# it can only guess. Minimal D-Bus wire code; it talks only to that private bus.
import json, os, re, socket, struct, sys, time

path, go_file = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else "hello"
serial = 0


def pad(b, n):
    return b + b"\0" * ((-len(b)) % n)


def string(b, v, sig="s"):
    raw = v.encode()
    if sig == "g":
        return b + bytes([len(raw)]) + raw + b"\0"
    b = pad(b, 4)
    return b + struct.pack("<I", len(raw)) + raw + b"\0"


def variant(b, sig, v):
    return string(string(b, sig, "g"), v, sig)


def call(dest, obj, iface, member, sig="", body=b""):
    global serial
    serial += 1
    fields = b""
    for code, t, v in [(1, "o", obj), (2, "s", iface), (3, "s", member), (6, "s", dest)] + ([(8, "g", sig)] if sig else []):
        fields = pad(fields, 8)
        fields += bytes([code])
        fields = variant(fields, t, v)
    head = b"l" + bytes([1, 0, 1]) + struct.pack("<II", len(body), serial) + struct.pack("<I", len(fields))
    return pad(head + fields, 8) + body


def exact(sock, n):
    out = b""
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise EOFError
        out += chunk
    return out


def reply(sock):
    while True:
        head = exact(sock, 16)
        kind = head[1]
        body_len, _, fields_len = struct.unpack("<III", head[4:16])
        rest = exact(sock, ((fields_len + 7) // 8) * 8 + body_len)
        if kind == 4:  # a signal (NameAcquired): not the reply
            continue
        text = "".join(chr(c) if 32 <= c < 127 else " " for c in rest)
        return {"type": {2: "return", 3: "error"}.get(kind, kind), "text": " ".join(text.split())}


def daemon_hello(sock):
    sock.sendall(call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello"))
    return re.search(r":\d+\.\d+", reply(sock)["text"]).group(0)


sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(path)
sock.sendall(b"\0AUTH EXTERNAL " + str(os.getuid()).encode().hex().encode() + b"\r\n")
assert sock.recv(4096).startswith(b"OK")
sock.sendall(b"BEGIN\r\n")
name = daemon_hello(sock) if mode == "hello" else None
print(json.dumps({"parent_pid": os.getpid(), "name": name}), flush=True)

if os.fork() != 0:
    os._exit(0)  # the opener goes; its connection lives on in the child

while not os.path.exists(go_file):
    time.sleep(0.02)
if name is None:
    name = daemon_hello(sock)
print(json.dumps({"name": name}), flush=True)
sock.sendall(call("org.galatea.PcBridge1", "/org/galatea/PcBridge1", "org.galatea.PcBridge1", "Hello", "s", string(b"", "0" * 64)))
print(json.dumps({"child_pid": os.getpid(), "hello": reply(sock)}), flush=True)
time.sleep(30)
