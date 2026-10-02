import {
  createAlertChannel,
  deleteAlertChannel,
  getAlertPolicy,
  getSmtpConfig,
  listAlertChannels,
  listAlertEvents,
  listAlertSubscriptions,
  setAlertPolicy,
  setSmtpConfig,
  subscribeAlerts,
  testAlertChannel,
  unsubscribeAlerts,
  updateAlertChannel,
  updateAlertSubscription,
} from "../../services/alerts";
import { authed } from "../base";

/** Alert channels, policy, subscriptions and events. */
export const alertsRouter = {
  alerts: {
    channels: authed.alerts.channels.handler(({ context }) => listAlertChannels(context.app)),
    createChannel: authed.alerts.createChannel.handler(({ input, context }) =>
      createAlertChannel(context.app, input, context.actor),
    ),
    updateChannel: authed.alerts.updateChannel.handler(({ input, context }) =>
      updateAlertChannel(context.app, input, context.actor),
    ),
    deleteChannel: authed.alerts.deleteChannel.handler(({ input, context }) =>
      deleteAlertChannel(context.app, input.id, context.actor),
    ),
    testChannel: authed.alerts.testChannel.handler(({ input, context }) =>
      testAlertChannel(context.app, input.id, context.actor),
    ),
    policy: authed.alerts.policy.handler(({ context }) => getAlertPolicy(context.app)),
    setPolicy: authed.alerts.setPolicy.handler(({ input, context }) =>
      setAlertPolicy(context.app, input, context.actor),
    ),
    smtp: authed.alerts.smtp.handler(({ context }) => getSmtpConfig(context.app)),
    setSmtp: authed.alerts.setSmtp.handler(({ input, context }) =>
      setSmtpConfig(context.app, input, context.actor),
    ),
    subscriptions: authed.alerts.subscriptions.handler(({ context }) =>
      listAlertSubscriptions(context.app, { actor: context.actor, userId: context.user.id }),
    ),
    subscribe: authed.alerts.subscribe.handler(({ input, context }) =>
      subscribeAlerts(context.app, input, { actor: context.actor, userId: context.user.id }),
    ),
    updateSubscription: authed.alerts.updateSubscription.handler(({ input, context }) =>
      updateAlertSubscription(context.app, input, {
        actor: context.actor,
        userId: context.user.id,
      }),
    ),
    unsubscribe: authed.alerts.unsubscribe.handler(({ input, context }) =>
      unsubscribeAlerts(context.app, input.id, { actor: context.actor, userId: context.user.id }),
    ),
    events: authed.alerts.events.handler(({ input, context }) =>
      listAlertEvents(context.app, input.siteId),
    ),
  },
};
