/** Per-session recorder controls embedded into the injected agent bundle. */

import { BINDING_NAME } from "@mirror/protocol";
import { DEFAULT_CANVAS_SITES } from "./canvas-sampler";

export const AGENT_CONFIG_KEY = Symbol.for("@mirror/agent/config");

export interface CanvasSnapshotConfig {
  enabled: boolean;
  fps: number;
  quality: number;
  /** Sites whose canvases are sampled for the page view, as challenges draw on them. */
  sites: string[];
}

export interface AgentConfig {
  canvas: CanvasSnapshotConfig;
  bridge: AgentBridgeConfig;
}

export interface AgentBridgeConfig {
  bindingName: string;
  rtcBindingName: string;
  bridgeKey: string;
  outboundEventName: string;
  inboundEventName: string;
  nodeResponseEventName: string;
  readyEventName: string;
}

export const MIN_CANVAS_FPS = 4;
export const MAX_CANVAS_FPS = 15;
export const MIN_CANVAS_QUALITY = 0.1;
export const MAX_CANVAS_QUALITY = 1;

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  canvas: {
    enabled: true,
    fps: 8,
    quality: 0.7,
    sites: [...DEFAULT_CANVAS_SITES],
  },
  bridge: {
    bindingName: BINDING_NAME,
    rtcBindingName: "__mirror_rtc_emit",
    bridgeKey: "__mirror_bridge",
    outboundEventName: "__mirror_outbound",
    inboundEventName: "__mirror_inbound",
    nodeResponseEventName: "__mirror_node_response",
    readyEventName: "__mirror_ready",
  },
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readAgentConfig(value: unknown): AgentConfig {
  const canvas =
    typeof value === "object" && value !== null && "canvas" in value
      ? (value as { canvas?: unknown }).canvas
      : undefined;
  const values = typeof canvas === "object" && canvas !== null ? canvas : {};
  const bridge =
    typeof value === "object" && value !== null && "bridge" in value
      ? (value as { bridge?: unknown }).bridge
      : undefined;
  const bridgeValues: Partial<Record<keyof AgentBridgeConfig, unknown>> =
    typeof bridge === "object" && bridge !== null ? bridge : {};
  const bridgeString = (key: keyof AgentBridgeConfig): string => {
    const candidate = key in bridgeValues ? bridgeValues[key] : undefined;
    return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
      ? candidate
      : DEFAULT_AGENT_CONFIG.bridge[key];
  };

  return {
    canvas: {
      enabled:
        "enabled" in values && typeof values.enabled === "boolean"
          ? values.enabled
          : DEFAULT_AGENT_CONFIG.canvas.enabled,
      fps: boundedNumber(
        "fps" in values ? values.fps : undefined,
        DEFAULT_AGENT_CONFIG.canvas.fps,
        MIN_CANVAS_FPS,
        MAX_CANVAS_FPS,
      ),
      quality: boundedNumber(
        "quality" in values ? values.quality : undefined,
        DEFAULT_AGENT_CONFIG.canvas.quality,
        MIN_CANVAS_QUALITY,
        MAX_CANVAS_QUALITY,
      ),
      sites:
        "sites" in values &&
        Array.isArray(values.sites) &&
        values.sites.length <= 50 &&
        values.sites.every(
          (site) => typeof site === "string" && site.length > 0 && site.length <= 200,
        )
          ? [...(values.sites as string[])]
          : [...DEFAULT_CANVAS_SITES],
    },
    bridge: {
      bindingName: bridgeString("bindingName"),
      rtcBindingName: bridgeString("rtcBindingName"),
      bridgeKey: bridgeString("bridgeKey"),
      outboundEventName: bridgeString("outboundEventName"),
      inboundEventName: bridgeString("inboundEventName"),
      nodeResponseEventName: bridgeString("nodeResponseEventName"),
      readyEventName: bridgeString("readyEventName"),
    },
  };
}
