import { schema } from "@edgeweir/db";
import { keyRing } from "./key-ring";

/** Keys rotate once the newest of them is this old. */
export const CHALLENGE_KEY_ROTATION_MS = 24 * 3600 * 1000;

/**
 * Pass keys of a cluster: nodes sign with current and accept all three. The
 * roles shift once a day, so a pass (at most 24 hours) expires before the
 * key that signed it is dropped, and during a canary the nodes on either
 * revision hold the key the other ones sign with. Secrets are 32 random bytes.
 */
const ring = keyRing({
  table: schema.challengeKey,
  rotationMs: CHALLENGE_KEY_ROTATION_MS,
  bytes: 32,
  purpose: "challenge_key.secret",
  configField: "challengeKeys",
  reason: "challenge_keys_rotated",
  action: "cluster.challenge_keys_rotate",
  label: "challenge key",
});

export const {
  binding: challengeKeyBinding,
  ensure: ensureChallengeKeys,
  rotate: rotateChallengeKeys,
  secrets: challengeKeySecrets,
} = ring;
