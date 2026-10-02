import { createBan, deleteBan, listBans } from "../../services/bans";
import { getSiteProtection, updateSiteProtection } from "../../services/protection";
import { topLoggedRules } from "../../services/rule-logs";
import {
  createIpList,
  deleteIpList,
  getRules,
  listIpLists,
  saveRules,
  updateIpList,
  validateExpression,
} from "../../services/rules";
import { listSecurityEvents, siteSecurityState } from "../../services/security";
import { getSiteWaf, topWafRules, updateSiteWaf } from "../../services/waf";
import { authed } from "../base";

/** Rules, IP lists, bans, CC protection, WAF and security events. */
export const accessControlRouter = {
  rules: {
    get: authed.rules.get.handler(({ input, context }) => getRules(context.app, input.id)),
    save: authed.rules.save.handler(({ input, context }) =>
      saveRules(context.app, input.id, input.rules, context),
    ),
    validate: authed.rules.validate.handler(({ input }) =>
      validateExpression(input.expression, input.phase, input.kind),
    ),
    topLogged: authed.rules.topLogged.handler(({ input, context }) =>
      topLoggedRules(context.app.db, input),
    ),
  },
  platformRules: {
    get: authed.platformRules.get.handler(({ context }) => getRules(context.app, null)),
    save: authed.platformRules.save.handler(({ input, context }) =>
      saveRules(context.app, null, input.rules, context),
    ),
  },
  ipLists: {
    list: authed.ipLists.list.handler(({ context }) => listIpLists(context.app)),
    create: authed.ipLists.create.handler(({ input, context }) =>
      createIpList(context.app, input, context.actor),
    ),
    update: authed.ipLists.update.handler(({ input, context }) =>
      updateIpList(context.app, input.id, input.entries, input.kind, context.actor),
    ),
    delete: authed.ipLists.delete.handler(({ input, context }) =>
      deleteIpList(context.app, input.id, context.actor),
    ),
  },
  bans: {
    list: authed.bans.list.handler(({ input, context }) => listBans(context.app.db, input)),
    create: authed.bans.create.handler(({ input, context }) =>
      createBan(context.app.db, input, { actor: context.actor }),
    ),
    delete: authed.bans.delete.handler(({ input, context }) =>
      deleteBan(context.app.db, input.id, { actor: context.actor }),
    ),
  },
  protection: {
    get: authed.protection.get.handler(({ input, context }) =>
      getSiteProtection(context.app.db, input.id),
    ),
    update: authed.protection.update.handler(({ input, context }) =>
      updateSiteProtection(context.app.db, input, { actor: context.actor }),
    ),
  },
  waf: {
    get: authed.waf.get.handler(({ input, context }) => getSiteWaf(context.app.db, input.id)),
    update: authed.waf.update.handler(({ input, context }) =>
      updateSiteWaf(context.app.db, input, { actor: context.actor }),
    ),
    topRules: authed.waf.topRules.handler(({ input, context }) =>
      topWafRules(context.app.db, input),
    ),
  },
  security: {
    state: authed.security.state.handler(({ input, context }) =>
      siteSecurityState(context.app.db, input.id, input.hours),
    ),
    events: authed.security.events.handler(({ input, context }) =>
      listSecurityEvents(context.app.db, input),
    ),
  },
};
