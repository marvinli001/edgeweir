import {
  activateExtensionVersion,
  addExtensionKey,
  deleteExtensionVersion,
  getExtension,
  getExtensionSettings,
  installExtension,
  listExtensionKeys,
  listExtensions,
  listSiteExtensions,
  removeExtensionKey,
  uninstallExtension,
  updateExtension,
  updateExtensionSettings,
  updateSiteExtension,
  verifyExtensionPackage,
} from "../../services/extensions";
import { authed } from "../base";

/** Node extensions and the publisher keys the operator trusts. */
export const extensionsRouter = {
  extensions: {
    list: authed.extensions.list.handler(({ context }) => listExtensions(context.app.db)),
    get: authed.extensions.get.handler(({ input, context }) =>
      getExtension(context.app.db, input.id),
    ),
    verify: authed.extensions.verify.handler(({ input, context }) =>
      verifyExtensionPackage(context.app.db, input),
    ),
    install: authed.extensions.install.handler(({ input, context }) =>
      installExtension(context.app.db, input, context.actor),
    ),
    activate: authed.extensions.activate.handler(({ input, context }) =>
      activateExtensionVersion(context.app.db, input, context.actor),
    ),
    deleteVersion: authed.extensions.deleteVersion.handler(({ input, context }) =>
      deleteExtensionVersion(context.app.db, input, context.actor),
    ),
    update: authed.extensions.update.handler(({ input, context }) =>
      updateExtension(context.app.db, input, context.actor),
    ),
    uninstall: authed.extensions.uninstall.handler(async ({ input, context }) => {
      await uninstallExtension(context.app.db, input.id, context.actor);
      return { ok: true as const };
    }),
    settings: authed.extensions.settings.handler(({ context }) =>
      getExtensionSettings(context.app.db),
    ),
    updateSettings: authed.extensions.updateSettings.handler(({ input, context }) =>
      updateExtensionSettings(context.app.db, input, context.actor),
    ),
    forSite: authed.extensions.forSite.handler(({ input, context }) =>
      listSiteExtensions(context.app.db, input.siteId),
    ),
    updateSite: authed.extensions.updateSite.handler(({ input, context }) =>
      updateSiteExtension(context.app.db, input, context.actor),
    ),
  },
  extensionKeys: {
    list: authed.extensionKeys.list.handler(({ context }) => listExtensionKeys(context.app.db)),
    add: authed.extensionKeys.add.handler(({ input, context }) =>
      addExtensionKey(context.app.db, input, context.actor),
    ),
    remove: authed.extensionKeys.remove.handler(async ({ input, context }) => {
      await removeExtensionKey(context.app.db, input.kid, context.actor);
      return { ok: true as const };
    }),
  },
};
