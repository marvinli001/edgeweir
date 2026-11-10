import * as z from "zod";

/** A private installer capability, never an AccessKey or a browser session. */
export const bootstrapInput = z.object({
  installationId: z.uuid(),
  requestId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
});

export const bootstrapResult = z.object({
  installationId: z.uuid(),
  userId: z.string(),
  clusterId: z.uuid(),
  accessKeyId: z.string(),
  accessKey: z.string(),
  caSha256: z.string(),
  recoveryExpiresAt: z.string(),
});

export type BootstrapInput = z.infer<typeof bootstrapInput>;
export type BootstrapResult = z.infer<typeof bootstrapResult>;

export const integrationAuthorizationResult = bootstrapResult.extend({
  clusterId: z.uuid().nullable(),
});
