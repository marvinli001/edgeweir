import { dnsCatalogDto } from "@edgeweir/contract";
import {
  createDnsProvider,
  deleteDnsProvider,
  exportBinding,
  forceBindingPublish,
  getBinding,
  getDnsProtection,
  listBindingRevisions,
  listBindings,
  listDnsProviders,
  listProviderZones,
  reconcileDns,
  rollbackBinding,
  saveBinding,
  setDnsProtection,
  siteDnsTarget,
  testProvider,
  updateDnsProvider,
} from "../../services/dns";
import { failFromCertd } from "../../services/dns-providers";
import { authed, ok } from "../base";

/** DNS providers and the clusters' DNS bindings. */
export const dnsRouter = {
  dns: {
    catalog: authed.dns.catalog.handler(() => dnsCatalogDto),
    updateProvider: authed.dns.updateProvider.handler(({ input, context }) =>
      updateDnsProvider(context.app, input, context.actor),
    ),
    providers: authed.dns.providers.handler(({ context }) => listDnsProviders(context.app)),
    createProvider: authed.dns.createProvider.handler(({ input, context }) =>
      createDnsProvider(context.app, input, context.actor),
    ),
    deleteProvider: authed.dns.deleteProvider.handler(({ input, context }) =>
      deleteDnsProvider(context.app, input.id, context.actor),
    ),
    zones: authed.dns.zones.handler(({ input, context }) => listProviderZones(context.app, input)),
    testProvider: authed.dns.testProvider.handler(({ input, context }) =>
      testProvider(context.app, input),
    ),
    bindings: authed.dns.bindings.handler(({ context }) => listBindings(context.app)),
    binding: authed.dns.binding.handler(({ input, context }) =>
      getBinding(context.app, input.clusterId),
    ),
    saveBinding: authed.dns.saveBinding.handler(({ input, context }) =>
      saveBinding(context.app, input.clusterId, input.binding, context.actor),
    ),
    bindingRevisions: authed.dns.bindingRevisions.handler(({ input, context }) =>
      listBindingRevisions(context.app, input.clusterId),
    ),
    rollbackBinding: authed.dns.rollbackBinding.handler(({ input, context }) =>
      rollbackBinding(context.app, input.clusterId, input.revision, context.actor),
    ),
    forcePublishBinding: authed.dns.forcePublishBinding.handler(({ input, context }) =>
      forceBindingPublish(context.app, input.clusterId, input.revision, context.actor),
    ),
    exportBinding: authed.dns.exportBinding.handler(({ input, context }) =>
      exportBinding(context.app, input.clusterId),
    ),
    protection: authed.dns.protection.handler(({ context }) => getDnsProtection(context.app.db)),
    setProtection: authed.dns.setProtection.handler(({ input, context }) =>
      setDnsProtection(context.app, input, context.actor),
    ),
    reconcile: authed.dns.reconcile.handler(async ({ input, context }) => {
      await reconcileDns(context.app, context.actor, input.clusterId).catch(failFromCertd);
      return ok;
    }),
    siteTarget: authed.dns.siteTarget.handler(({ input, context }) =>
      siteDnsTarget(context.app, input.siteId),
    ),
  },
};
