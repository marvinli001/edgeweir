import { deleteAcmeAccount, listAcmeAccounts } from "../../services/acme-accounts";
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
import {
  activateOriginClientCa,
  cancelOriginCaRotation,
  cancelOriginClientCaRotation,
  createOriginCa,
  createOriginClientCa,
  getOriginCa,
  getOriginClientCa,
  issueOriginCertificate,
  listOriginCertificates,
  retireOriginCa,
  retireOriginClientCa,
  revokeOriginCertificate,
  rotateOriginCa,
  rotateOriginClientCa,
} from "../../services/origin-pki";
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
  originClientCa: {
    get: authed.originClientCa.get.handler(({ context }) => getOriginClientCa(context.app)),
    create: authed.originClientCa.create.handler(({ context }) =>
      createOriginClientCa(context.app, context),
    ),
    rotate: authed.originClientCa.rotate.handler(({ context }) =>
      rotateOriginClientCa(context.app, context),
    ),
    activate: authed.originClientCa.activate.handler(({ context }) =>
      activateOriginClientCa(context.app, context),
    ),
    retire: authed.originClientCa.retire.handler(({ context }) =>
      retireOriginClientCa(context.app, context),
    ),
    cancel: authed.originClientCa.cancel.handler(({ context }) =>
      cancelOriginClientCaRotation(context.app, context),
    ),
  },
  originCa: {
    get: authed.originCa.get.handler(({ context }) => getOriginCa(context.app)),
    create: authed.originCa.create.handler(({ context }) => createOriginCa(context.app, context)),
    rotate: authed.originCa.rotate.handler(({ context }) => rotateOriginCa(context.app, context)),
    retire: authed.originCa.retire.handler(({ context }) => retireOriginCa(context.app, context)),
    cancel: authed.originCa.cancel.handler(({ context }) =>
      cancelOriginCaRotation(context.app, context),
    ),
  },
  originCertificates: {
    list: authed.originCertificates.list.handler(({ context }) =>
      listOriginCertificates(context.app),
    ),
    issue: authed.originCertificates.issue.handler(({ input, context }) =>
      issueOriginCertificate(context.app, input, context),
    ),
    revoke: authed.originCertificates.revoke.handler(({ input, context }) =>
      revokeOriginCertificate(context.app, input, context),
    ),
  },
  acmeAccounts: {
    list: authed.acmeAccounts.list.handler(({ context }) => listAcmeAccounts(context.app)),
    delete: authed.acmeAccounts.delete.handler(({ input, context }) =>
      deleteAcmeAccount(context.app, input.id, context.actor),
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
