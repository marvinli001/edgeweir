import { schema } from "@edgeweir/db";
import { keyRing } from "./key-ring";

/**
 * Secrets are 80 random bytes, the file format of nginx's
 * ssl_session_ticket_key: a 16-byte key name, a 32-byte AES-256 key and a
 * 32-byte HMAC-SHA256 key.
 */
export const SESSION_TICKET_KEY_BYTES = 80;

/**
 * TLS session ticket keys of a cluster: nodes encrypt tickets with current
 * and decrypt with all three, so a node that applies a rotation before
 * another still accepts the tickets the other one issues, and back. The
 * roles shift every 12 hours; nodes accept a ticket for at most an hour
 * (ssl_session_timeout), long before the key that encrypted it is dropped.
 * Created when a configuration of the cluster first carries them.
 */
const ring = keyRing({
  table: schema.sessionTicketKey,
  rotationMs: 12 * 3600 * 1000,
  bytes: SESSION_TICKET_KEY_BYTES,
  purpose: "session_ticket_key.secret",
  configField: "sessionTicketKeys",
  reason: "session_ticket_keys_rotated",
  action: "cluster.session_ticket_keys_rotate",
  label: "session ticket key",
});

export const {
  binding: sessionTicketKeyBinding,
  ensure: ensureSessionTicketKeys,
  rotate: rotateSessionTicketKeys,
  secrets: sessionTicketKeySecrets,
} = ring;
