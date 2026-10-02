import { getBanSettings, setBanSettings } from "../../services/bans";
import { getPlatformErrorPages, setPlatformErrorPages } from "../../services/error-pages";
import { checkNodeChannel } from "../../services/node-channel-check";
import { getOriginAllowList, setOriginAllowList } from "../../services/origin-allow-list";
import { getProbeSettings, setProbeSettings } from "../../services/probes";
import {
  getCcTemplate,
  getProtectionSettings,
  setCcTemplate,
  setProtectionSettings,
} from "../../services/protection";
import { getReleaseSource, setReleaseSource } from "../../services/release-source";
import { setupCompletedAt } from "../../services/setup";
import { getUsageSettings, setUsageSettings } from "../../services/usage";
import { authed } from "../base";

/** Platform settings. */
export const settingsRouter = {
  settings: {
    get: authed.settings.get.handler(async ({ context }) => ({
      version: context.app.env.version,
      consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
      nodeApiUrl: context.app.env.nodeApiUrl,
      nodeCaSha256: context.app.nodeCa.fingerprintSha256,
      analyticsMode: context.app.env.EDGEWEIR_ANALYTICS,
      setupCompletedAt: await setupCompletedAt(context.app.db),
    })),
    nodeChannelCheck: authed.settings.nodeChannelCheck.handler(({ context }) =>
      checkNodeChannel(context.app),
    ),
    originAllowList: authed.settings.originAllowList.handler(({ context }) =>
      getOriginAllowList(context.app.db),
    ),
    setOriginAllowList: authed.settings.setOriginAllowList.handler(({ input, context }) =>
      setOriginAllowList(context.app.db, input, context.actor),
    ),
    releaseSource: authed.settings.releaseSource.handler(({ context }) =>
      getReleaseSource(context.app),
    ),
    setReleaseSource: authed.settings.setReleaseSource.handler(({ input, context }) =>
      setReleaseSource(context.app, input, context.actor),
    ),
    bans: authed.settings.bans.handler(({ context }) => getBanSettings(context.app.db)),
    setBans: authed.settings.setBans.handler(({ input, context }) =>
      setBanSettings(context.app.db, input, context.actor),
    ),
    protection: authed.settings.protection.handler(({ context }) =>
      getProtectionSettings(context.app.db),
    ),
    setProtection: authed.settings.setProtection.handler(({ input, context }) =>
      setProtectionSettings(context.app.db, input, context.actor),
    ),
    ccTemplate: authed.settings.ccTemplate.handler(({ context }) => getCcTemplate(context.app.db)),
    setCcTemplate: authed.settings.setCcTemplate.handler(({ input, context }) =>
      setCcTemplate(context.app.db, input, context.actor),
    ),
    errorPages: authed.settings.errorPages.handler(({ context }) =>
      getPlatformErrorPages(context.app.db),
    ),
    setErrorPages: authed.settings.setErrorPages.handler(({ input, context }) =>
      setPlatformErrorPages(context.app.db, input, context.actor),
    ),
    probes: authed.settings.probes.handler(({ context }) => getProbeSettings(context.app.db)),
    setProbes: authed.settings.setProbes.handler(({ input, context }) =>
      setProbeSettings(context.app.db, input, context.actor),
    ),
    usage: authed.settings.usage.handler(({ context }) => getUsageSettings(context.app.db)),
    setUsage: authed.settings.setUsage.handler(({ input, context }) =>
      setUsageSettings(context.app.db, input, context.actor),
    ),
  },
};
