import {
  certificateSettings,
  createDnsCredential,
  deleteCertificate,
  deleteDnsCredential,
  dnsCredentialZones,
  listCertificates,
  listDnsCredentials,
  renewCertificate,
  requestCertificate,
  testDnsCredential,
  updateDnsCredential,
  uploadCertificate,
} from "../../services/certificates";
import { authed } from "../base";

/** Certificates and the DNS credentials of DNS-01 validation. */
export const certificatesRouter = {
  certificates: {
    list: authed.certificates.list.handler(({ context }) => listCertificates(context.app)),
    settings: authed.certificates.settings.handler(({ context }) =>
      certificateSettings(context.app),
    ),
    upload: authed.certificates.upload.handler(({ input, context }) =>
      uploadCertificate(context.app, input, context),
    ),
    request: authed.certificates.request.handler(({ input, context }) =>
      requestCertificate(context.app, input, context),
    ),
    renew: authed.certificates.renew.handler(({ input, context }) =>
      renewCertificate(context.app, input.id, context),
    ),
    delete: authed.certificates.delete.handler(({ input, context }) =>
      deleteCertificate(context.app, input.id, context),
    ),
  },
  dnsCredentials: {
    list: authed.dnsCredentials.list.handler(({ context }) => listDnsCredentials(context.app)),
    create: authed.dnsCredentials.create.handler(({ input, context }) =>
      createDnsCredential(context.app, input, context),
    ),
    update: authed.dnsCredentials.update.handler(({ input, context }) =>
      updateDnsCredential(context.app, input, context),
    ),
    delete: authed.dnsCredentials.delete.handler(({ input, context }) =>
      deleteDnsCredential(context.app, input.id, context),
    ),
    zones: authed.dnsCredentials.zones.handler(({ input, context }) =>
      dnsCredentialZones(context.app, input),
    ),
    test: authed.dnsCredentials.test.handler(({ input, context }) =>
      testDnsCredential(context.app, input),
    ),
  },
};
