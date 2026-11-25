import { Controller } from "./controller";
import { Relay } from "./relay";
import type { Decide } from "./types";
import { createUi, scopeOf, type Connection } from "./ui";

export const inject = ["react", "pages", "relay", "navigation", "host", "shortcuts", "settingsCards"];

function optional(ctx: any, name: string): any {
  try {
    return ctx.reflect?.get?.(name) ?? ctx.get?.(name) ?? ctx[name];
  } catch {
    return undefined;
  }
}

export function apply(ctx: any): void {
  let cached: { key: string; relay: Relay } | null = null;
  const relay = (): Relay | null => {
    const connection: Connection = ctx.relay.snapshot();
    if (connection.status !== "ready" || !connection.session || !connection.viewer) return null;
    const key = `${connection.scope}:${connection.generation}`;
    if (cached?.key !== key) {
      connection.session.channels?.ensureList?.();
      cached = { key, relay: new Relay(connection.session, connection.viewer) };
    }
    return cached.relay;
  };

  const decide = (): Decide | null => {
    const decisions = optional(ctx, "decisions");
    return decisions?.decide ? (request) => decisions.decide(request) : null;
  };

  const controller = new Controller({
    host: ctx.host,
    relay,
    decide,
    community: () => scopeOf(ctx.relay.snapshot())?.communityOrigin,
  });

  ctx.effect(() => controller.start(), "buzz-voice controller");
  ctx.effect(() => ctx.relay.subscribe(() => controller.onRelayChanged()), "buzz-voice relay sync");

  // Auto-pause mic/Live mode when a native Buzz Huddle is active
  ctx.effect(() => {
    const huddleStatus = optional(ctx, "huddleStatus");
    if (!huddleStatus?.subscribe || !huddleStatus?.snapshot) return undefined;
    const sync = () => {
      try {
        const snap = huddleStatus.snapshot();
        const active = !!(snap?.active || snap?.inHuddle || snap?.state === "connected" || snap?.channelId);
        controller.setHuddleActive(active);
      } catch {
        // ignore
      }
    };
    sync();
    return huddleStatus.subscribe(sync);
  }, "buzz-voice huddle auto-pause");

  const { Page, SettingsCard } = createUi({
    React: ctx.react,
    controller,
    relayService: ctx.relay,
    relay,
    navigation: ctx.navigation,
  });

  ctx.pages.register({ id: "main", title: "Buzz Voice", primary: true, component: Page });
  ctx.settingsCards.register({ id: "settings", title: "Buzz Voice", component: SettingsCard, personal: true });
  ctx.shortcuts.register({
    id: "live",
    title: "Buzz Voice: Live conversation on or off",
    binding: { key: "l", mod: true, shift: true },
    allowInEditable: true,
    run: () => controller.toggleLiveMode(),
  });
  ctx.shortcuts.register({
    id: "talk",
    title: "Buzz Voice: start or stop talking",
    binding: { key: " ", mod: true, shift: true },
    allowInEditable: true,
    run: () => {
      void controller.toggleListening();
    },
  });
  ctx.shortcuts.register({
    id: "hands-free",
    title: "Buzz Voice: hands-free on or off",
    binding: { key: "h", mod: true, shift: true },
    allowInEditable: true,
    run: () => controller.toggleHandsFree(),
  });
  ctx.shortcuts.register({
    id: "stop-speaking",
    title: "Buzz Voice: stop speaking / interrupt",
    binding: { key: ".", mod: true, shift: true },
    allowInEditable: true,
    run: () => controller.stopSpeaking(),
  });
}
