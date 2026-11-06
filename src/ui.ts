import { mentionsIn, type Controller, type LogEntry, type VoiceState } from "./controller";
import { listMicrophones, type Settings } from "./engine";
import { emojiCounts, emptyFlagSource, groupFlags, loadFlags, type Flag, type FlagSource } from "./flags";
import type { Relay } from "./relay";

const TAP_MS = 400;
const FLAG_REFRESH_MS = 60_000;
const SETTINGS_SECTION = "blueoi.buzz-voice/settings";

export interface Connection {
  status: string;
  session?: any;
  scope?: string;
  viewer?: string;
  generation?: number;
  error?: string;
}

export interface UiDeps {
  React: any;
  controller: Controller;
  relayService: { subscribe(listener: () => void): () => void; snapshot(): Connection };
  relay: () => Relay | null;
  navigation: { open(target: unknown): Promise<{ status: string } | undefined> };
}

export function scopeOf(connection: Connection): { communityOrigin: string; viewer: string } | undefined {
  const scope = connection.scope ?? "";
  const at = scope.lastIndexOf(":");
  if (at < 0 || scope.slice(at + 1) !== connection.viewer) return undefined;
  return { communityOrigin: scope.slice(0, at), viewer: connection.viewer as string };
}

function ago(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

const CSS = `
.bv-root{display:flex;flex-direction:column;height:100%;min-height:0}
.bv-body{display:flex;flex-direction:column;flex:1;min-height:0}
.bv-bar{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:var(--space-2) var(--space-panel-inset)}
.bv-segmented{width:100%;max-width:18rem}
.bv-segmented[data-compact]{max-width:12rem}
.bv-segmented .buzz-tabs-tab[data-selected]{background:var(--surface-control-selected);box-shadow:var(--shadow-xs)}
.bv-dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--text-disabled);flex:none}
.bv-dot[data-state=online]{background:var(--text-success)}
.bv-dot[data-state=error]{background:var(--text-danger)}
.bv-scope{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:0 var(--space-panel-inset) var(--space-2);min-width:0}
.bv-truncate{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bv-log{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-2) var(--space-panel-inset) var(--space-4)}
.bv-log>.buzz-empty-state{margin:auto 0}
.bv-turn{display:flex;flex-direction:column;gap:var(--space-1);max-width:min(85%,42rem)}
.bv-turn[data-role=you]{align-self:flex-end;align-items:flex-end}
.bv-turn[data-role=app]{align-self:flex-start}
.bv-bubble{padding:var(--space-2) var(--space-3);border-radius:var(--radius-card);white-space:pre-wrap;overflow-wrap:anywhere}
.bv-turn[data-role=you] .bv-bubble{background:var(--surface-message-own);color:var(--text-message-own)}
.bv-turn[data-role=app] .bv-bubble{background:var(--surface-inset);color:var(--text-standard)}
.bv-turn[data-bad] .bv-bubble{color:var(--text-danger)}
.bv-meta{display:flex;align-items:center;gap:var(--space-2);padding:0 var(--space-1)}
.bv-card{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--border-standard);border-radius:var(--radius-container);background:var(--surface-panel);box-shadow:var(--shadow-card)}
.bv-row{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
.bv-row-end{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.bv-footer{flex:none;display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3) var(--space-panel-inset) var(--space-4);border-top:1px solid var(--border-standard)}
.bv-talk{display:flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;min-height:3.5rem;border:1px solid var(--border-standard);border-radius:var(--radius-container);background:var(--surface-inset);color:var(--text-standard);font:inherit;cursor:pointer;touch-action:none;user-select:none;transition:background var(--duration-fast),color var(--duration-fast)}
.bv-talk:hover:not(:disabled){background:var(--affordance-subtle-hover)}
.bv-talk[data-listening]{background:var(--affordance-accent-prominent);border-color:transparent;color:var(--text-on-accent)}
.bv-talk:disabled{opacity:.55;cursor:default}
.bv-talk svg{flex:none}
.bv-meter{height:.1875rem;border-radius:var(--radius-pill);background:var(--surface-inset);overflow:hidden}
.bv-meter>span{display:block;height:100%;background:var(--affordance-accent-prominent);transition:width 60ms linear}
.bv-status{min-height:1.25rem;margin:0;text-align:center}
.bv-type{display:flex;gap:var(--space-2);align-items:center}
.bv-type>.buzz-input{flex:1;min-width:0}
.bv-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 var(--space-panel-inset) var(--space-6)}
.bv-flags{list-style:none;margin:0;padding:0}
.bv-flag{display:flex;align-items:flex-start;gap:var(--space-2);border-bottom:1px solid var(--border-standard);padding:var(--space-1) 0}
.bv-flag:last-child{border-bottom:0}
.bv-flag-open{display:flex;gap:var(--space-3);flex:1;min-width:0;padding:var(--space-2);border:0;border-radius:var(--radius-row);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bv-flag-open:hover{background:var(--affordance-row-hover)}
.bv-flag-emoji{flex:none;min-width:2.75rem;white-space:nowrap;font-size:1.125rem;line-height:1.5rem}
.bv-flag-text{display:flex;flex-direction:column;gap:var(--space-half);min-width:0}
.bv-flag-side{flex:none;padding-top:var(--space-1)}
.bv-settings{display:flex;flex-direction:column}
.bv-settings>.buzz-content-header[data-inline]{margin-top:var(--space-section-gap);margin-bottom:var(--space-2)}
.bv-form{display:flex;flex-direction:column;gap:var(--space-4)}
.bv-settings>.buzz-settings-group+.buzz-settings-group{margin-top:var(--space-3)}
.bv-kbd{font-family:var(--font-mono, ui-monospace, monospace);padding:0 var(--space-1);border:1px solid var(--border-standard);border-radius:var(--radius-chip);background:var(--surface-inset)}
`;

const ICON = {
  mic: "M128 176a48.05 48.05 0 0 0 48-48V64a48 48 0 0 0-96 0v64a48.05 48.05 0 0 0 48 48ZM96 64a32 32 0 0 1 64 0v64a32 32 0 0 1-64 0Zm40 143.6V232a8 8 0 0 1-16 0v-24.4A80.11 80.11 0 0 1 48 128a8 8 0 0 1 16 0 64 64 0 0 0 128 0 8 8 0 0 1 16 0 80.11 80.11 0 0 1-72 79.6Z",
  stop: "M200 40H56a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Zm0 160H56V56h144Z",
  speakerOff: "M53.92 34.62a8 8 0 1 0-11.84 10.76L73.55 80H32a16 16 0 0 0-16 16v64a16 16 0 0 0 16 16h43.25l69.84 54.31A8 8 0 0 0 160 224v-46.24l42.08 46.29a8 8 0 1 0 11.84-10.76ZM32 96h40v64H32Zm112 111.64-56-43.55V95.06l56 61.6Zm-42.32-148.8a8 8 0 0 1 1.4-11.23l41.83-32.53A8 8 0 0 1 160 32v76.92a8 8 0 0 1-16 0V48.36l-31.08 24.17a8 8 0 0 1-11.24-1.4Zm110.4 105.39a8 8 0 0 1-11-2.7 47.85 47.85 0 0 0 0-49.06 8 8 0 1 1 13.7-8.28 63.81 63.81 0 0 1 0 65.62 8 8 0 0 1-2.7 2.7Zm32.25-.92A95.43 95.43 0 0 0 248 128a95.35 95.35 0 0 0-14.72-51 8 8 0 1 1 13.56-8.5 111.45 111.45 0 0 1 0 119 8 8 0 1 1-13.56-8.5Z",
  plus: "M224 128a8 8 0 0 1-8 8h-80v80a8 8 0 0 1-16 0v-80H40a8 8 0 0 1 0-16h80V40a8 8 0 0 1 16 0v80h80a8 8 0 0 1 8 8Z",
  gear: "M128 80a48 48 0 1 0 48 48 48.05 48.05 0 0 0-48-48Zm0 80a32 32 0 1 1 32-32 32 32 0 0 1-32 32Zm88-29.84q.06-2.16 0-4.32l14.92-18.64a8 8 0 0 0 1.48-7.06 107.6 107.6 0 0 0-10.88-26.25 8 8 0 0 0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186 40.54a8 8 0 0 0-3.94-6 107.29 107.29 0 0 0-26.25-10.86 8 8 0 0 0-7.06 1.48L130.16 40q-2.16-.06-4.32 0L107.2 25.11a8 8 0 0 0-7.06-1.48 107.6 107.6 0 0 0-26.25 10.88 8 8 0 0 0-3.93 6l-2.64 23.76q-1.56 1.49-3 3L40.54 70a8 8 0 0 0-6 3.94 107.71 107.71 0 0 0-10.87 26.25 8 8 0 0 0 1.49 7.06L40 125.84q-.06 2.16 0 4.32L25.11 148.8a8 8 0 0 0-1.48 7.06 107.6 107.6 0 0 0 10.88 26.25 8 8 0 0 0 6 3.93l23.72 2.64q1.49 1.56 3 3L70 215.46a8 8 0 0 0 3.94 6 107.71 107.71 0 0 0 26.25 10.87 8 8 0 0 0 7.06-1.49L125.84 216q2.16.06 4.32 0l18.64 14.92a8 8 0 0 0 7.06 1.48 107.21 107.21 0 0 0 26.25-10.88 8 8 0 0 0 3.93-6l2.64-23.72q1.56-1.48 3-3l23.78-2.8a8 8 0 0 0 6-3.94 107.71 107.71 0 0 0 10.87-26.25 8 8 0 0 0-1.49-7.06Zm-16.1-6.5a73.93 73.93 0 0 1 0 8.68 8 8 0 0 0 1.74 5.48l14.19 17.73a91.57 91.57 0 0 1-6.23 15l-22.6 2.56a8 8 0 0 0-5.1 2.64 74.11 74.11 0 0 1-6.14 6.14 8 8 0 0 0-2.64 5.1l-2.51 22.58a91.32 91.32 0 0 1-15 6.23l-17.74-14.19a8 8 0 0 0-5-1.75h-.48a73.93 73.93 0 0 1-8.68 0 8 8 0 0 0-5.48 1.74l-17.78 14.2a91.57 91.57 0 0 1-15-6.23L82.89 187a8 8 0 0 0-2.64-5.1 74.11 74.11 0 0 1-6.14-6.14 8 8 0 0 0-5.1-2.64l-22.58-2.52a91.32 91.32 0 0 1-6.23-15l14.19-17.74a8 8 0 0 0 1.74-5.48 73.93 73.93 0 0 1 0-8.68 8 8 0 0 0-1.74-5.48L40.2 100.45a91.57 91.57 0 0 1 6.23-15L69 82.89a8 8 0 0 0 5.1-2.64 74.11 74.11 0 0 1 6.14-6.14A8 8 0 0 0 82.89 69l2.51-22.57a91.32 91.32 0 0 1 15-6.23l17.74 14.19a8 8 0 0 0 5.48 1.74 73.93 73.93 0 0 1 8.68 0 8 8 0 0 0 5.48-1.74l17.77-14.19a91.57 91.57 0 0 1 15 6.23L173.11 69a8 8 0 0 0 2.64 5.1 74.11 74.11 0 0 1 6.14 6.14 8 8 0 0 0 5.1 2.64l22.58 2.51a91.32 91.32 0 0 1 6.23 15l-14.19 17.74a8 8 0 0 0-1.74 5.53Z",
  refresh: "M240 56v48a8 8 0 0 1-8 8h-48a8 8 0 0 1 0-16h27.4l-26.59-24.36-.25-.24a80 80 0 1 0-1.67 114.78 8 8 0 0 1 11 11.63A95.44 95.44 0 0 1 128 224h-1.32a96 96 0 1 1 69.07-164L224 85.8V56a8 8 0 0 1 16 0Z",
  flag: "M42.76 50A8 8 0 0 0 40 56v168a8 8 0 0 0 16 0v-44.23c26.79-21.16 49.87-9.75 76.45 3.41 16.4 8.11 34.06 16.85 53 16.85 13.93 0 28.54-4.75 43.82-18a8 8 0 0 0 2.76-6V56a8 8 0 0 0-13.27-6c-28 24.23-51.72 12.49-79.21-1.12C111.07 34.76 78.78 18.79 42.76 50ZM216 172.25c-26.79 21.16-49.87 9.74-76.45-3.41-25-12.35-52.81-26.13-83.55-8.4V59.79c26.79-21.16 49.87-9.75 76.45 3.4 25 12.35 52.82 26.13 83.55 8.4Z",
};

export function createUi(deps: UiDeps) {
  const { React, controller, relayService, navigation } = deps;
  const h = React.createElement;
  const { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React;

  const useVoice = (): VoiceState => useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const useConnection = (): Connection =>
    useSyncExternalStore(relayService.subscribe, relayService.snapshot, relayService.snapshot);

  const Icon = ({ name, size = 16 }: { name: keyof typeof ICON; size?: number | string }) =>
    h(
      "svg",
      { width: size, height: size, viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": true, focusable: "false" },
      h("path", { d: ICON[name] }),
    );

  function Button({
    variant = "subtle",
    size = "md",
    loading = false,
    disabled,
    children,
    ...props
  }: {
    variant?: string;
    size?: string;
    loading?: boolean;
    disabled?: boolean;
    children: any;
    [key: string]: any;
  }) {
    return h(
      "button",
      {
        type: "button",
        ...props,
        disabled: disabled || loading,
        "aria-busy": loading || undefined,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant,
        "data-size": size,
        "data-button-shape": "capsule",
        "data-loading": loading || undefined,
      },
      h("span", { className: "buzz-button-label" }, children),
    );
  }

  function IconButton({ label, icon, ...props }: { label: string; icon: keyof typeof ICON; [key: string]: any }) {
    return h(
      "button",
      {
        type: "button",
        ...props,
        "aria-label": label,
        title: label,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": "ghost",
        "data-size": "sm",
        "data-button-shape": "capsule",
        "data-icon-variant": "ghost",
        "data-icon-size": "sm",
        "data-icon-shape": "control",
      },
      h("span", { className: "buzz-button-label" }, h(Icon, { name: icon })),
    );
  }

  const Input = (props: Record<string, unknown>) =>
    h("input", { type: "text", ...props, "data-buzz-ui": "", "data-size": "md", className: "buzz-input" });

  function Field({ label, description, children }: { label: string; description?: string; children: any }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label" }, label, children),
      description && h("p", { className: "buzz-field-description" }, description),
    );
  }

  function Header({ title, subtitle, inline = false, actions }: { title: string; subtitle?: string; inline?: boolean; actions?: any }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": inline || undefined },
      h(
        "div",
        { className: "buzz-content-header-copy" },
        h(inline ? "h3" : "h2", { className: "buzz-content-header-title" }, title),
        subtitle && h("p", { className: "buzz-content-header-subtitle" }, subtitle),
      ),
      actions && h("div", { className: "buzz-content-header-actions" }, actions),
    );
  }

  const Group = ({ layout = "rows", children }: { layout?: string; children: any }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": layout }, children);

  function Row({ title, subtitle, trailing }: { title: any; subtitle?: any; trailing?: any }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" },
      h(
        "div",
        { className: "buzz-preference-row-content" },
        h("div", { className: "buzz-preference-row-label" }, title),
        subtitle && h("span", { className: "buzz-preference-row-description" }, subtitle),
      ),
      trailing != null && h("div", { className: "buzz-preference-row-trailing" }, trailing),
    );
  }

  function Switch({ checked, onChange, label }: { checked: boolean; onChange(next: boolean): void; label: string }) {
    const state = checked ? { "data-checked": "" } : { "data-unchecked": "" };
    return h(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        "data-buzz-ui": "",
        className: "buzz-switch-control",
        ...state,
        onClick: () => onChange(!checked),
      },
      h("span", { className: "buzz-switch-thumb", ...state }),
    );
  }

  function EmptyState({ icon, title, description, action }: { icon: keyof typeof ICON; title: string; description?: any; action?: any }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-empty-state" },
      h(
        "div",
        { className: "buzz-empty-state-content" },
        h("span", { className: "buzz-empty-state-icon", "aria-hidden": true }, h(Icon, { name: icon, size: 24 })),
        h(
          "div",
          { className: "buzz-empty-state-copy" },
          h("h3", { className: "buzz-empty-state-title" }, title),
          description != null && h("p", { className: "buzz-empty-state-description" }, description),
        ),
        action && h("div", { className: "buzz-empty-state-action" }, action),
      ),
    );
  }

  function Segmented({ label, value, options, onChange, compact }: { label: string; value: string; options: [string, string][]; onChange(v: string): void; compact?: boolean }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-tabs bv-segmented", "data-variant": "segmented", "data-size": "sm", "data-compact": compact || undefined },
      h(
        "div",
        { className: "buzz-tabs-list", role: "tablist", "aria-label": label },
        options.map(([id, text]) =>
          h(
            "button",
            {
              key: id,
              type: "button",
              role: "tab",
              className: "buzz-tabs-tab text-label-sm",
              "aria-selected": value === id,
              "data-selected": value === id ? "" : undefined,
              onClick: () => onChange(id),
            },
            text,
          ),
        ),
      ),
    );
  }

  function openTarget(channelId: string, messageId: string, rootId: string): void {
    const scope = scopeOf(relayService.snapshot());
    if (!scope) return;
    void navigation.open({ version: 1, kind: "conversation", scope, channelId, messageId, threadRootId: rootId });
  }

  const openSettings = () => void navigation.open({ version: 1, kind: "settings", section: SETTINGS_SECTION });

  function Setup({ voice }: { voice: VoiceState }) {
    const engine = voice.engine;
    const missing = engine
      ? [!engine.engine && "the speech engine", !engine.model && `the whisper ${voice.settings.whisper} model`].filter(Boolean).join(" and ")
      : "";
    return h(EmptyState, {
      icon: "mic",
      title: "Set up speech",
      description: voice.engineError
        ? voice.engineError
        : `Speech is transcribed on this Mac with sherpa-onnx, the same as the Buzz Voice app. ${missing ? `Install ${missing} to start.` : "Checking for the engine..."}`,
      action: h(
        "div",
        { className: "bv-row", style: { justifyContent: "center" } },
        h(
          Button,
          { variant: "prominent", loading: !!voice.installing, onClick: () => void controller.install() },
          voice.installing || "Install speech engine",
        ),
        h(Button, { variant: "subtle", onClick: () => void controller.refreshEngine() }, "Check again"),
      ),
    });
  }

  function Turn({ entry }: { entry: LogEntry }) {
    return h(
      "div",
      { className: "bv-turn", "data-role": entry.role, "data-bad": entry.bad || undefined },
      (entry.meta || entry.link) &&
        h(
          "div",
          { className: "bv-meta text-caption text-subtle" },
          entry.meta && h("span", null, entry.meta),
          entry.link &&
            h(
              Button,
              {
                variant: "link",
                size: "caption",
                onClick: () => openTarget(entry.link!.channelId, entry.link!.messageId, entry.link!.rootId),
              },
              "Open in Buzz",
            ),
        ),
      h("div", { className: "bv-bubble text-body-sm" }, entry.text),
    );
  }

  function Confirm({ voice }: { voice: VoiceState }) {
    const pending = voice.pending!;
    const ref = useRef(null as any);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange?.(field.value.length, field.value.length);
    }, [pending.channel.id, pending.replyTo]);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }, [pending.body]);
    const found = mentionsIn(pending.body, pending.members);
    const unmatched = found.length === 0 && pending.body.includes("@");
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return h(
      "div",
      { className: "bv-card", role: "group", "aria-label": "Confirm message" },
      h(
        "div",
        { className: "bv-row" },
        h("span", { className: "text-label-sm text-standard" }, `#${pending.channel.name}`),
        pending.label && h("span", { className: "text-caption text-subtle bv-truncate" }, `in “${pending.label}”`),
      ),
      h("textarea", {
        ref,
        "aria-label": "Message to send",
        value: pending.body,
        rows: 2,
        spellCheck: false,
        "data-buzz-ui": "",
        className: "buzz-textarea",
        "data-variant": "text",
        "data-surface": "inset",
        "data-appearance": "field",
        style: { resize: "none", overflow: "hidden" },
        onChange: (event: any) => controller.editPending(event.target.value),
        onKeyDown: (event: any) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void controller.publish();
          }
          if (event.key === "Escape") controller.cancel();
        },
      }),
      h(
        "p",
        { className: `text-caption ${unmatched ? "text-danger" : "text-subtle"}`, style: { margin: 0 } },
        found.length
          ? `Notifies ${found.map((m) => m.name).join(", ")}`
          : unmatched
            ? "Nobody in this channel matches that name, so nobody will be notified."
            : "Nobody will be notified.",
      ),
      found.length === 0 &&
        pending.members.length > 0 &&
        h(
          "div",
          { className: "bv-row" },
          pending.members.slice(0, 8).map((member) =>
            h(
              Button,
              {
                key: member.pubkey,
                variant: "subtle",
                size: "sm",
                onClick: () => {
                  const stripped = pending.addressed
                    ? pending.body.replace(new RegExp(`^\\s*@${escape(pending.addressed)}\\s*`, "i"), "")
                    : pending.body;
                  controller.editPending(`@${member.name} ${stripped.trim()}`);
                },
              },
              `@${member.name}`,
            ),
          ),
        ),
      pending.orphaned &&
        h("p", { className: "text-caption text-warning", style: { margin: 0 } }, `No thread open in ${pending.channel.name}, so this posts as a new message.`),
      h(
        "div",
        { className: "bv-row-end" },
        h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Enter or say “yes” to send"),
        h(Button, { variant: "subtle", onClick: () => controller.cancel() }, "Cancel"),
        h(Button, { variant: "prominent", onClick: () => void controller.publish() }, "Send"),
      ),
    );
  }

  function TalkButton({ voice }: { voice: VoiceState }) {
    const pressedAt = useRef(0);
    const label = voice.opening
      ? "Opening the microphone..."
      : voice.transcribing
      ? "Transcribing..."
      : voice.listening
        ? voice.latched
          ? "Recording. Tap to stop"
          : "Listening. Release to send"
        : "Tap or hold to talk";
    const down = (event: any) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (voice.listening && voice.latched) {
        void controller.stopListening();
        return;
      }
      pressedAt.current = Date.now();
      void controller.startListening();
    };
    const up = () => {
      const now = controller.snapshot();
      if (!now.listening || now.latched) return;
      if (Date.now() - pressedAt.current < TAP_MS) controller.latch();
      else void controller.stopListening();
    };
    return h(
      "button",
      {
        type: "button",
        className: "bv-talk text-label",
        disabled: !voice.ready || voice.transcribing,
        "data-listening": voice.listening || undefined,
        "aria-pressed": voice.listening,
        onPointerDown: down,
        onPointerUp: up,
        onPointerCancel: up,
        onKeyDown: (event: any) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void controller.toggleListening();
          }
        },
      },
      h(Icon, { name: voice.listening ? "stop" : "mic", size: 20 }),
      label,
    );
  }

  function Talk({ voice }: { voice: VoiceState }) {
    const [typed, setTyped] = useState("");
    const log = useRef(null as any);
    useEffect(() => {
      if (voice.ready) controller.warmMicrophone();
    }, [voice.ready, voice.settings.microphone]);
    useEffect(() => {
      const node = log.current;
      if (node) node.scrollTop = node.scrollHeight;
    }, [voice.log.length, !!voice.pending]);
    const level = Math.min(1, voice.level * 3);
    const watching = voice.watches.length;
    return h(
      Fragment,
      null,
      (voice.scope || watching > 0) &&
        h(
          "div",
          { className: "bv-scope text-caption text-subtle" },
          voice.scope && h("span", { className: "bv-truncate", title: voice.scope }, voice.scope),
          watching > 0 &&
            h(
              "span",
              { title: voice.watches.map((w) => `${w.channelName}: ${w.label}`).join("\n") },
              `${voice.scope ? "· " : ""}Watching ${watching} ${watching === 1 ? "thread" : "threads"}`,
            ),
        ),
      h(
        "div",
        { className: "bv-log", ref: log, role: "log", "aria-live": "polite" },
        !voice.ready && voice.log.length === 0
          ? h(Setup, { voice })
          : voice.log.length === 0 && !voice.pending
            ? h(EmptyState, {
                icon: "mic",
                title: "Talk to Buzz",
                description: "“In ops, tell build-bot to rerun the deploy.” “How is work going in ops?” “What’s in my inbox?”",
              })
            : null,
        voice.log.map((entry) => h(Turn, { key: entry.id, entry })),
        voice.pending && h(Confirm, { voice }),
      ),
      h(
        "div",
        { className: "bv-footer" },
        h("div", { className: "bv-meter", "aria-hidden": true }, h("span", { style: { width: `${Math.round(level * 100)}%` } })),
        h(TalkButton, { voice }),
        h(
          "p",
          { className: `bv-status text-caption ${voice.statusBad ? "text-danger" : "text-subtle"}`, role: voice.statusBad ? "alert" : "status" },
          voice.status || (voice.ready ? "Or press ⌘⇧Space anywhere in Buzz" : ""),
        ),
        h(
          "form",
          {
            className: "bv-type",
            onSubmit: (event: any) => {
              event.preventDefault();
              controller.submitText(typed);
              setTyped("");
            },
          },
          h(Input, {
            "aria-label": "Type a command",
            placeholder: "Or type what you would say",
            value: typed,
            disabled: voice.busy,
            onChange: (event: any) => setTyped(event.target.value),
          }),
          h(Button, { type: "submit", variant: "subtle", disabled: voice.busy || !typed.trim() }, "Send"),
        ),
      ),
    );
  }

  function Flags({ relay }: { relay: Relay }) {
    const voice = useVoice();
    const [source, setSource] = useState(emptyFlagSource() as FlagSource);
    const [status, setStatus] = useState("loading");
    const [mineOnly, setMineOnly] = useState(false);
    const [emoji, setEmoji] = useState(null as string | null);
    const load = useCallback(() => {
      setStatus((current: string) => (current === "loading" ? current : "refreshing"));
      loadFlags(relay)
        .then((next) => {
          setSource(next);
          setStatus("");
        })
        .catch((error) => setStatus(`Could not read reactions: ${error?.message ?? error}`));
    }, [relay]);
    useEffect(() => {
      load();
      const timer = setInterval(load, FLAG_REFRESH_MS);
      return () => clearInterval(timer);
    }, [load]);
    const channelNames = useMemo(() => new Map(relay.channels().map((c) => [c.id, c.name])), [relay, source]);
    const counts: [string, number][] = useMemo(() => emojiCounts(source, mineOnly), [source, mineOnly]);
    const total = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji: null }).length, [source, channelNames, mineOnly]);
    const flags: Flag[] = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji }), [source, channelNames, mineOnly, emoji]);
    const failed = status && status !== "loading" && status !== "refreshing";
    return h(
      Fragment,
      null,
      h(
        "div",
        { className: "bv-bar", style: { paddingTop: 0 } },
        h(Segmented, {
          label: "Whose flags",
          compact: true,
          value: mineOnly ? "mine" : "everyone",
          options: [
            ["everyone", "Everyone"],
            ["mine", "Mine"],
          ],
          onChange: (v: string) => setMineOnly(v === "mine"),
        }),
        h("span", { style: { flex: 1 } }),
        h(IconButton, { label: "Refresh", icon: "refresh", disabled: status === "refreshing" || status === "loading", onClick: load }),
      ),
      h(
        "div",
        { className: "bv-bar", role: "radiogroup", "aria-label": "Emoji", style: { paddingTop: 0 } },
        h(Button, { variant: emoji === null ? "prominent" : "subtle", size: "sm", role: "radio", "aria-checked": emoji === null, onClick: () => setEmoji(null) }, `All ${total}`),
        counts.map(([e, count]) =>
          h(
            Button,
            {
              key: e,
              variant: emoji === e ? "prominent" : "subtle",
              size: "sm",
              role: "radio",
              "aria-checked": emoji === e,
              onClick: () => setEmoji(emoji === e ? null : e),
            },
            `${e} ${count}`,
          ),
        ),
      ),
      h(
        "div",
        { className: "bv-scroll" },
        status === "loading"
          ? h("p", { className: "text-body-sm text-subtle" }, "Reading reactions...")
          : failed
            ? h("p", { className: "text-body-sm text-danger", role: "alert" }, status)
            : flags.length === 0
              ? h(EmptyState, { icon: "flag", title: "No flagged threads", description: mineOnly ? "Threads you react to show up here." : "Threads with reactions show up here." })
              : h(
                  "ul",
                  { className: "bv-flags" },
                  flags.map((flag) => {
                    const following = voice.watches.some((w) => w.rootId === flag.rootId);
                    return h(
                      "li",
                      { key: flag.rootId, className: "bv-flag" },
                      h(
                        "button",
                        { type: "button", className: "bv-flag-open", onClick: () => openTarget(flag.channelId, flag.messageId, flag.rootId) },
                        h("span", { className: "bv-flag-emoji" }, flag.emoji.join("")),
                        h(
                          "span",
                          { className: "bv-flag-text" },
                          h("span", { className: "text-label-sm text-standard bv-truncate" }, flag.title),
                          flag.excerpt && h("span", { className: "text-body-sm text-subtle bv-truncate" }, flag.excerpt),
                          h("span", { className: "text-caption text-subtle bv-truncate" }, `#${flag.channelName} · ${flag.who.join(", ")} · ${ago(flag.at)}`),
                        ),
                      ),
                      h(
                        "span",
                        { className: "bv-flag-side" },
                        h(
                          Button,
                          {
                            variant: following ? "prominent" : "subtle",
                            size: "sm",
                            "aria-pressed": following,
                            onClick: () =>
                              following
                                ? controller.unwatch(flag.rootId)
                                : controller.watch({
                                    rootId: flag.rootId,
                                    channelId: flag.channelId,
                                    channelName: flag.channelName,
                                    label: flag.title,
                                    since: Math.floor(Date.now() / 1000),
                                  }),
                          },
                          following ? "Following" : "Follow",
                        ),
                      ),
                    );
                  }),
                ),
      ),
    );
  }

  function Page() {
    const connection = useConnection();
    const voice = useVoice();
    const [tab, setTab] = useState("talk");
    const relay = useMemo(
      () => (connection.status === "ready" ? deps.relay() : null),
      [connection.scope, connection.generation, connection.status],
    );
    useEffect(() => {
      if (connection.status === "ready") connection.session?.channels?.ensureList?.();
    }, [connection.session]);
    const online = connection.status === "ready" ? "online" : connection.status === "error" ? "error" : "offline";
    return h(
      "div",
      { className: "h-full min-h-0", style: { height: "100%", minHeight: 0 } },
      h("style", null, CSS),
      h(
        "section",
        { "data-buzz-surface": "", "data-shape": "panel", className: "panel", "aria-label": "Buzz Voice", style: { height: "100%" } },
        h(
          "div",
          { "data-buzz-ui": "", className: "bv-root" },
          h(
            "header",
            { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
            h(
              "div",
              { className: "panel-header-title" },
              h(
                "div",
                { className: "panel-header-label" },
                h("span", { className: "panel-header-label-icon", "aria-hidden": true }, h(Icon, { name: "mic", size: "1rem" })),
                h("h2", null, "Buzz Voice"),
                h("span", { className: "bv-dot", "data-state": online, title: online === "online" ? "Connected" : connection.error || "Connecting" }),
              ),
            ),
            h(
              "div",
              { className: "panel-header-actions" },
              h(IconButton, { label: "Stop speaking", icon: "speakerOff", onClick: () => controller.stopSpeaking() }),
              h(IconButton, { label: "New session", icon: "plus", onClick: () => controller.newSession() }),
              h(IconButton, { label: "Buzz Voice settings", icon: "gear", onClick: openSettings }),
            ),
          ),
          h(
            "div",
            { className: "bv-bar" },
            h(Segmented, {
              label: "Buzz Voice",
              value: tab,
              options: [
                ["talk", "Talk"],
                ["flags", "Flags"],
              ],
              onChange: setTab,
            }),
          ),
          h(
            "div",
            { className: "bv-body" },
            connection.status !== "ready" || !relay
              ? h(
                  "div",
                  { className: "bv-scroll" },
                  h(EmptyState, {
                    icon: "mic",
                    title: connection.status === "error" ? "Could not connect" : "Connecting",
                    description: connection.status === "error" ? (connection.error ?? "Buzz could not reach the community.") : "Waiting for the community connection.",
                  }),
                )
              : tab === "talk"
                ? h(Talk, { voice })
                : h(Flags, { key: `${connection.scope}:${connection.generation}`, relay }),
          ),
        ),
      ),
    );
  }

  function LlmForm({ settings }: { settings: Settings }) {
    const [draft, setDraft] = useState({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
    const [saved, setSaved] = useState(false);
    useEffect(() => {
      setDraft({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
    }, [settings.llmUrl, settings.llmModel, settings.llmKey]);
    const dirty = draft.llmUrl !== settings.llmUrl || draft.llmModel !== settings.llmModel || draft.llmKey !== settings.llmKey;
    const invalid = draft.llmUrl.trim() !== "" && !/^https?:\/\/[^\s]+$/i.test(draft.llmUrl.trim());
    const set = (key: keyof typeof draft) => (event: any) => {
      setSaved(false);
      setDraft({ ...draft, [key]: event.target.value });
    };
    return h(
      Group,
      { layout: "form" },
      h(
        "form",
        {
          className: "bv-form",
          noValidate: true,
          onSubmit: (event: any) => {
            event.preventDefault();
            if (invalid) return;
            controller.updateSettings({ llmUrl: draft.llmUrl.trim(), llmModel: draft.llmModel.trim(), llmKey: draft.llmKey.trim() });
            setSaved(true);
          },
        },
        h(
          Field,
          { label: "Endpoint", description: invalid ? undefined : "OpenAI-compatible base URL, http or https." },
          h(Input, { value: draft.llmUrl, onChange: set("llmUrl"), placeholder: "http://localhost:4000/v1", spellCheck: false, autoCapitalize: "off", autoCorrect: "off" }),
        ),
        invalid && h("p", { className: "buzz-field-error text-caption text-danger", role: "alert", style: { margin: 0 } }, "Enter a URL starting with http:// or https://."),
        h(Field, { label: "Model" }, h(Input, { value: draft.llmModel, onChange: set("llmModel"), placeholder: "default", spellCheck: false })),
        h(
          Field,
          { label: "API key", description: "Optional. Stored on this device only." },
          h(Input, { type: "password", value: draft.llmKey, onChange: set("llmKey"), autoComplete: "off" }),
        ),
        h(
          "div",
          { className: "bv-row-end", style: { marginTop: "var(--space-2)" } },
          saved && !dirty && h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Saved"),
          h(
            Button,
            {
              variant: "subtle",
              disabled: !dirty,
              onClick: () => {
                setDraft({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
              },
            },
            "Discard",
          ),
          h(Button, { type: "submit", variant: "prominent", disabled: !dirty || invalid }, "Save"),
        ),
      ),
    );
  }

  function SpeechForm({ settings }: { settings: Settings }) {
    const [draft, setDraft] = useState({ modelDir: settings.modelDir, whisper: settings.whisper });
    useEffect(() => setDraft({ modelDir: settings.modelDir, whisper: settings.whisper }), [settings.modelDir, settings.whisper]);
    const dirty = draft.modelDir !== settings.modelDir || draft.whisper !== settings.whisper;
    return h(
      "form",
      {
        className: "bv-form",
        noValidate: true,
        onSubmit: (event: any) => {
          event.preventDefault();
          controller.updateSettings({ modelDir: draft.modelDir.trim() || "~/buzz-voice-models", whisper: draft.whisper.trim() || "small.en" });
          void controller.refreshEngine();
        },
      },
      h(Field, { label: "Model folder" }, h(Input, { value: draft.modelDir, onChange: (e: any) => setDraft({ ...draft, modelDir: e.target.value }), spellCheck: false })),
      h(
        Field,
        { label: "Whisper model", description: "small.en matches the Buzz Voice app. base.en and tiny.en are faster and less accurate." },
        h(Input, { value: draft.whisper, onChange: (e: any) => setDraft({ ...draft, whisper: e.target.value }), spellCheck: false }),
      ),
      dirty &&
        h(
          "div",
          { className: "bv-row-end" },
          h(Button, { variant: "subtle", onClick: () => setDraft({ modelDir: settings.modelDir, whisper: settings.whisper }) }, "Discard"),
          h(Button, { type: "submit", variant: "prominent" }, "Save"),
        ),
    );
  }

  function MicrophonePicker({ value }: { value: string }) {
    const [devices, setDevices]: [{ id: string; label: string }[], (v: { id: string; label: string }[]) => void] = useState([]);
    useEffect(() => {
      let live = true;
      const load = () => void listMicrophones().then((list) => live && setDevices(list)).catch(() => undefined);
      load();
      navigator.mediaDevices?.addEventListener?.("devicechange", load);
      return () => {
        live = false;
        navigator.mediaDevices?.removeEventListener?.("devicechange", load);
      };
    }, []);
    return h(
      "select",
      {
        "aria-label": "Microphone",
        "data-buzz-ui": "",
        className: "buzz-input",
        "data-size": "md",
        style: { width: "14rem", maxWidth: "100%" },
        value,
        onChange: (e: any) => controller.updateSettings({ microphone: e.target.value }),
      },
      h("option", { value: "" }, "System default"),
      devices.map((d) => h("option", { key: d.id, value: d.id }, d.label)),
      value && !devices.some((d) => d.id === value) && h("option", { value }, "Saved microphone (not connected)"),
    );
  }

  function SettingsCard() {
    const voice = useVoice();
    const settings = voice.settings;
    const engine = voice.engine;
    const status = voice.installing
      ? `${voice.installing}...`
      : voice.engineError
        ? voice.engineError
        : !engine
          ? "Checking..."
          : engine.engine && engine.model
            ? `Ready. Whisper ${settings.whisper}, transcribed on this device.`
            : `Missing ${[!engine.engine && "the engine", !engine.model && "the model"].filter(Boolean).join(" and ")}.`;
    const ready = !!engine?.engine && !!engine?.model;
    return h(
      "section",
      { className: "bv-settings", "aria-labelledby": "bv-settings-title" },
      h("style", null, CSS),
      h(Header, { title: "Buzz Voice", subtitle: "Talk to Buzz and find threads by emoji." }),
      h(Header, { inline: true, title: "Speech to text" }),
      h(
        Group,
        null,
        h(Row, {
          title: "Speech engine",
          subtitle: h("span", { className: voice.engineError ? "text-danger" : undefined }, status),
          trailing: h(
            Button,
            {
              variant: ready ? "subtle" : "prominent",
              size: "sm",
              loading: !!voice.installing,
              onClick: () => void (ready ? controller.refreshEngine() : controller.install()),
            },
            ready ? "Check" : "Install",
          ),
        }),
      ),
      h(Group, { layout: "form" }, h(SpeechForm, { settings })),
      h(Header, {
        inline: true,
        title: "Language model",
        subtitle: "Writes messages and reads channels back. Routing uses your Decisions API provider when one is on.",
      }),
      h(LlmForm, { settings }),
      h(Header, { inline: true, title: "Microphone" }),
      h(Group, null, h(Row, { title: "Input", subtitle: "The microphone stays open while you use Buzz Voice, so talking starts instantly. It closes after 10 idle minutes.", trailing: h(MicrophonePicker, { value: settings.microphone }) })),
      h(Header, { inline: true, title: "Spoken replies" }),
      h(
        Group,
        null,
        h(Row, {
          title: "Read replies out loud",
          subtitle: "Answers and new replies in watched threads.",
          trailing: h(Switch, { label: "Read replies out loud", checked: settings.speak, onChange: (next: boolean) => controller.updateSettings({ speak: next }) }),
        }),
        h(Row, {
          title: "Voice",
          subtitle: "A macOS voice name. Blank uses the system voice.",
          trailing: h(Input, {
            "aria-label": "Voice",
            value: settings.voice,
            placeholder: "System",
            style: { width: "10rem" },
            onChange: (e: any) => controller.updateSettings({ voice: e.target.value }),
          }),
        }),
      ),
      h(Header, { inline: true, title: "Shortcuts" }),
      h(
        Group,
        null,
        h(Row, { title: "Start or stop talking", trailing: h("kbd", { className: "bv-kbd text-caption" }, "⌘⇧Space") }),
        h(Row, { title: "Stop speaking", trailing: h("kbd", { className: "bv-kbd text-caption" }, "⌘⇧.") }),
      ),
    );
  }

  return { Page, SettingsCard };
}
