import { WEBSOCKET_IDLE, type WebsocketSettings } from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { ListText } from "@/components/site/access-control/fields";
import { AccessPartCard } from "@/components/site/access-control/part-card";
import { NumberField } from "@/components/site/fields";
import { m } from "@/lib/i18n";

type Draft = Omit<WebsocketSettings, "idleTimeoutSeconds"> & { idleTimeoutSeconds: string };

/**
 * WebSocket upgrades: from any origin (the default) or only the listed ones (others get 403), and
 * how long an upgraded connection may stay idle (a config rule's origin timeouts still win).
 */
export function WebsocketCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="websocket"
      title={m.access_ws_title()}
      testId="websocket"
      index={index}
      toDraft={(value): Draft => ({
        ...value,
        idleTimeoutSeconds: String(value.idleTimeoutSeconds),
      })}
      toPart={(draft) => ({
        ...draft,
        idleTimeoutSeconds:
          draft.idleTimeoutSeconds.trim() === "" ? Number.NaN : Number(draft.idleTimeoutSeconds),
      })}
      inUse={(value) =>
        !value.allowAllOrigins || value.idleTimeoutSeconds !== WEBSOCKET_IDLE.default
      }
      labels={{
        origins: m.access_ws_origins,
        idleTimeoutSeconds: m.access_ws_idle,
      }}
    >
      {({ draft, set, blocked, invalid }) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_10rem]">
            <FormSelect
              id="websocket-origins-mode"
              label={m.access_ws_origins_mode()}
              value={draft.allowAllOrigins ? "all" : "list"}
              options={[
                { value: "all", label: m.access_ws_all() },
                { value: "list", label: m.access_ws_list() },
              ]}
              disabled={blocked}
              onChange={(mode) => set({ allowAllOrigins: mode === "all" })}
              testId="websocket-origins-mode"
            />
            <NumberField
              id="websocket-idle"
              label={m.access_ws_idle()}
              value={draft.idleTimeoutSeconds}
              min={WEBSOCKET_IDLE.min}
              max={WEBSOCKET_IDLE.max}
              step={1}
              disabled={blocked}
              invalid={invalid("idleTimeoutSeconds")}
              onChange={(idleTimeoutSeconds) => set({ idleTimeoutSeconds })}
              testId="websocket-idle"
            />
          </div>
          {draft.allowAllOrigins ? null : (
            <div className="animate-in fade-in">
              <ListText
                id="websocket-origins"
                label={m.access_ws_origins()}
                value={draft.origins}
                placeholder={"https://app.example.com\nhttps://admin.example.com"}
                disabled={blocked}
                invalid={invalid("origins")}
                onChange={(origins) => set({ origins })}
                testId="websocket-origins"
              />
            </div>
          )}
        </>
      )}
    </AccessPartCard>
  );
}
