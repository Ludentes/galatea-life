-- The whole-applier review's M6: the secrets the applier only ever compares are kept as SHA-256
-- digests, so a dump of the store gives away no client's bearer and no recent setup code. It names
-- no schema (the storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- A client's bearer credential, as the lowercase hex of its SHA-256; a caller's bearer is hashed and
-- compared in constant time. The token key stays as it is: it is the HMAC key, and has to be read.
ALTER TABLE clients RENAME COLUMN credential TO credential_sha256;
UPDATE clients SET credential_sha256 = encode(sha256(convert_to(credential_sha256, 'UTF8')), 'hex');

-- A keyed provisioning request's body (RFC 8785, without its key), kept only to compare a repeat of
-- its key with: its SHA-256 does that as well, and a Matter commission's setup code is no longer kept.
UPDATE provisions SET body = encode(sha256(convert_to(body, 'UTF8')), 'hex') WHERE body IS NOT NULL;
