/**
 * Claude's microphone and sound, on a browser that has neither.
 *
 * The real browser runs on a server, so the page's microphone is fed from the viewer's device and
 * what the page plays is sent back to it. Doing this inside the page keeps every client's audio on
 * its own connection, where a shared system sound device would mix them together. Whole-tab capture
 * was the alternative, but Chromium shows a sharing bar with it, which changes the page's height.
 */
import { VOICE_SAMPLE_RATE, decodeVoiceSamples, encodeVoiceSamples } from "@mirror/protocol";
import type { NativeMask } from "./native-mask";

/** About 85 ms at the voice rate: a low enough message rate for the binding. */
const FRAME_SAMPLES = 2048;
const SILENT_PEAK = 0.0005;
/** Keeps sending this many silent frames, so the end of a sound is not cut off. */
const SILENT_FRAMES_KEPT = 4;
const MIC_ANSWER_TIMEOUT_MS = 60_000;
/** Scheduling ahead of the clock absorbs uneven arrival. */
const MIC_LEAD_S = 0.06;
const MIC_MAX_LAG_S = 0.4;

export type VoiceOut = { audio: string } | { mic: boolean };
export type VoiceIn = { state: boolean } | { pcm: string };

export interface VoiceBridge {
  receive(value: unknown): void;
}

export function installVoiceBridge(
  target: Window & typeof globalThis,
  send: (message: VoiceOut) => void,
  /** Hardening: the replaced Web Audio and media methods look like the browser's own. */
  mask?: NativeMask,
): VoiceBridge {
  const masked = <T extends object>(name: string, fake: T, original: object): T =>
    mask === undefined
      ? fake
      : (mask.method(name, fake as unknown as () => unknown, original) as unknown as T);
  const NativeAudioContext = target.AudioContext;
  const NativeOffline = target.OfflineAudioContext;
  const NativeDestination = target.AudioDestinationNode;
  const NativeMediaStream = target.MediaStream;
  const nativeConnect = target.AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode,
  ) => AudioNode;
  const nativeDisconnect = target.AudioNode.prototype.disconnect as (
    this: AudioNode,
    destination: AudioNode,
  ) => void;

  let hub: AudioContext | null = null;
  let mixer: GainNode;
  let micOut: MediaStreamAudioDestinationNode;
  let frameNode: ScriptProcessorNode;
  let silentFrames = SILENT_FRAMES_KEPT;

  const getHub = (): AudioContext => {
    if (hub !== null) return hub;
    hub = new NativeAudioContext({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
    mixer = hub.createGain();
    micOut = hub.createMediaStreamDestination();
    // Claude's page may not allow a worklet's script, and this needs nothing loaded.
    frameNode = hub.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    const sink = hub.createGain();
    sink.gain.value = 0;
    nativeConnect.call(mixer, frameNode);
    nativeConnect.call(frameNode, sink);
    nativeConnect.call(sink, hub.destination);
    frameNode.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      silentFrames = peak < SILENT_PEAK ? silentFrames + 1 : 0;
      if (silentFrames > SILENT_FRAMES_KEPT) return;
      send({ audio: encodeVoiceSamples(samples) });
    };
    void hub.resume();
    return hub;
  };

  // Sound made with Web Audio: whatever reaches a context's output also reaches the mixer.
  const contextTaps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>();
  const tapOf = (context: BaseAudioContext): MediaStreamAudioDestinationNode | null => {
    if (context instanceof NativeOffline || context === hub) return null;
    let tap = contextTaps.get(context);
    if (tap === undefined) {
      tap = (context as AudioContext).createMediaStreamDestination();
      contextTaps.set(context, tap);
      nativeConnect.call(getHub().createMediaStreamSource(tap.stream), mixer);
    }
    return tap;
  };
  const connect = function (this: AudioNode, ...args: unknown[]): unknown {
    const result = (nativeConnect as (...a: unknown[]) => unknown).apply(this, args);
    if (args[0] instanceof NativeDestination) {
      const tap = tapOf(this.context);
      if (tap !== null) nativeConnect.call(this, tap);
    }
    return result;
  };
  target.AudioNode.prototype.connect = masked(
    "connect",
    connect,
    nativeConnect,
  ) as typeof AudioNode.prototype.connect;
  const disconnect = function (this: AudioNode, ...args: unknown[]): unknown {
    if (args[0] instanceof NativeDestination) {
      const tap = contextTaps.get(this.context);
      try {
        if (tap !== undefined) nativeDisconnect.call(this, tap);
      } catch {
        // It was not connected to the tap, which leaves nothing to undo.
      }
    }
    return (nativeDisconnect as (...a: unknown[]) => unknown).apply(this, args);
  };
  target.AudioNode.prototype.disconnect = masked(
    "disconnect",
    disconnect,
    nativeDisconnect,
  ) as typeof AudioNode.prototype.disconnect;

  // Sound from media elements, unless the page routes the element through Web Audio above.
  const elementGains = new WeakMap<HTMLMediaElement, GainNode>();
  const routedElements = new WeakSet<HTMLMediaElement>();
  const nativeElementSource = target.AudioContext.prototype.createMediaElementSource;
  target.AudioContext.prototype.createMediaElementSource = masked(
    "createMediaElementSource",
    function (this: AudioContext, element: HTMLMediaElement) {
      routedElements.add(element);
      const gain = elementGains.get(element);
      if (gain) gain.gain.value = 0;
      return nativeElementSource.call(this, element);
    },
    nativeElementSource,
  );
  const tapElement = (element: HTMLMediaElement): void => {
    if (elementGains.has(element) || routedElements.has(element)) return;
    const capture = (element as HTMLMediaElement & { captureStream?(): MediaStream }).captureStream;
    if (capture === undefined) return;
    const gain = getHub().createGain();
    nativeConnect.call(gain, mixer);
    elementGains.set(element, gain);
    const level = () => {
      if (routedElements.has(element)) return;
      gain.gain.value = element.muted ? 0 : element.volume;
    };
    level();
    element.addEventListener("volumechange", level);
    const stream = capture.call(element);
    const attach = () => {
      if (stream.getAudioTracks().length === 0) return;
      stream.removeEventListener("addtrack", attach);
      nativeConnect.call(
        hub!.createMediaStreamSource(new NativeMediaStream(stream.getAudioTracks())),
        gain,
      );
    };
    stream.addEventListener("addtrack", attach);
    attach();
  };
  const nativePlay = target.HTMLMediaElement.prototype.play;
  target.HTMLMediaElement.prototype.play = masked(
    "play",
    function (this: HTMLMediaElement) {
      try {
        tapElement(this);
      } catch {
        // Playback matters more than hearing it here; the page must never see this fail.
      }
      return nativePlay.call(this);
    },
    nativePlay,
  );
  // WebRTC voice elements often receive srcObject with autoplay rather than an explicit play() call.
  const srcObjectDescriptor = Object.getOwnPropertyDescriptor(
    target.HTMLMediaElement.prototype,
    "srcObject",
  );
  if (srcObjectDescriptor?.set !== undefined) {
    const nativeSetSrcObject = srcObjectDescriptor.set;
    const setSrcObject = function (this: HTMLMediaElement, value: MediaProvider | null) {
      nativeSetSrcObject.call(this, value);
      if (value !== null) {
        try {
          tapElement(this);
        } catch {
          // Playback matters more than hearing it here; the page must never see this fail.
        }
      }
    };
    if (mask !== undefined) {
      mask.accessor(target.HTMLMediaElement.prototype, "srcObject", {
        set: setSrcObject as unknown as (this: never, value: never) => void,
      });
    } else {
      Object.defineProperty(target.HTMLMediaElement.prototype, "srcObject", {
        ...srcObjectDescriptor,
        set: setSrcObject,
      });
    }
  }

  // The microphone.
  const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);
    target.crypto.getRandomValues(buffer);
    let hex = "";
    for (const byte of buffer) hex += byte.toString(16).padStart(2, "0");
    return hex;
  };
  const micDeviceId = randomHex(32);
  const micGroupId = randomHex(32);
  const MIC_LABEL = "Default - Microphone";
  const MIC_SAMPLE_RATE = 48_000;

  let micOpen = false;
  let micGrantedOnce = false;
  let micTracks = 0;
  const micWaiters: ((granted: boolean) => void)[] = [];
  const micStatuses = new Set<PermissionStatus>();
  const maskedDevices = new WeakSet<object>();
  let devicePrototypeHooked = false;
  let nextMicAt = 0;

  const hookDeviceInfoPrototype = (): void => {
    if (devicePrototypeHooked) return;
    const proto = (target as unknown as { MediaDeviceInfo?: { prototype: MediaDeviceInfo } })
      .MediaDeviceInfo?.prototype;
    if (!proto) return;
    devicePrototypeHooked = true;
    const hookGetter = (key: "deviceId" | "groupId" | "label" | "kind", value: string) => {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc?.get) return;
      const nativeGet = desc.get;
      const getter = function (this: MediaDeviceInfo): string {
        if (maskedDevices.has(this)) return value;
        return nativeGet.call(this);
      };
      if (mask !== undefined) {
        mask.accessor(proto, key, { get: getter as unknown as (this: never) => unknown });
      } else {
        Object.defineProperty(proto, key, { ...desc, get: getter });
      }
    };
    hookGetter("deviceId", micDeviceId);
    hookGetter("groupId", micGroupId);
    hookGetter("label", MIC_LABEL);
    hookGetter("kind", "audioinput");
    const nativeToJson = proto.toJSON;
    if (typeof nativeToJson === "function") {
      proto.toJSON = masked(
        "toJSON",
        function (this: MediaDeviceInfo) {
          if (maskedDevices.has(this)) {
            return {
              deviceId: micDeviceId,
              kind: "audioinput",
              label: MIC_LABEL,
              groupId: micGroupId,
            };
          }
          return nativeToJson.call(this);
        },
        nativeToJson,
      );
    }
  };
  const openMic = (): Promise<boolean> => {
    if (micOpen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(false), MIC_ANSWER_TIMEOUT_MS);
      const answer = (granted: boolean) => {
        clearTimeout(timer);
        const at = micWaiters.indexOf(answer);
        if (at >= 0) micWaiters.splice(at, 1);
        resolve(granted);
      };
      micWaiters.push(answer);
      if (micWaiters.length === 1) send({ mic: true });
    });
  };
  const trackStopped = (): void => {
    micTracks -= 1;
    if (micTracks > 0) return;
    micOpen = false;
    send({ mic: false });
  };
  /** Hardening: the microphone's tracks, masked so WebAudio destination strings never leak. */
  const issuedTracks = new WeakMap<MediaStreamTrack, { stopped: boolean }>();
  let trackPrototypeHooked = false;
  const hookTrackPrototype = (track: MediaStreamTrack): void => {
    if (trackPrototypeHooked) return;
    trackPrototypeHooked = true;
    const prototype = Object.getPrototypeOf(track) as MediaStreamTrack;
    const nativeStop = prototype.stop;
    prototype.stop = masked(
      "stop",
      function (this: MediaStreamTrack) {
        nativeStop.call(this);
        const issued = issuedTracks.get(this);
        if (issued === undefined || issued.stopped) return;
        issued.stopped = true;
        trackStopped();
      },
      nativeStop,
    );
    const nativeClone = prototype.clone;
    if (typeof nativeClone === "function") {
      prototype.clone = masked(
        "clone",
        function (this: MediaStreamTrack) {
          const cloned = nativeClone.call(this);
          const issued = issuedTracks.get(this);
          if (issued !== undefined) {
            if (!issued.stopped) micTracks += 1;
            issuedTracks.set(cloned, { stopped: issued.stopped });
          }
          return cloned;
        },
        nativeClone,
      );
    }
    const labelDescriptor = Object.getOwnPropertyDescriptor(prototype, "label");
    if (labelDescriptor?.get !== undefined) {
      const nativeGetLabel = labelDescriptor.get;
      const getLabel = function (this: MediaStreamTrack): string {
        if (issuedTracks.has(this)) return MIC_LABEL;
        return nativeGetLabel.call(this);
      };
      if (mask !== undefined) {
        mask.accessor(prototype, "label", {
          get: getLabel as unknown as (this: never) => unknown,
        });
      } else {
        Object.defineProperty(prototype, "label", { ...labelDescriptor, get: getLabel });
      }
    }
    const nativeGetSettings = prototype.getSettings;
    if (typeof nativeGetSettings === "function") {
      prototype.getSettings = masked(
        "getSettings",
        function (this: MediaStreamTrack): MediaTrackSettings {
          const settings = nativeGetSettings.call(this);
          if (!issuedTracks.has(this)) return settings;
          return {
            ...settings,
            autoGainControl: true,
            channelCount: 1,
            deviceId: micDeviceId,
            echoCancellation: true,
            groupId: micGroupId,
            noiseSuppression: true,
            sampleRate: MIC_SAMPLE_RATE,
            sampleSize: 16,
          };
        },
        nativeGetSettings,
      );
    }
    const nativeGetCapabilities = (
      prototype as MediaStreamTrack & { getCapabilities?(): MediaTrackCapabilities }
    ).getCapabilities;
    if (typeof nativeGetCapabilities === "function") {
      prototype.getCapabilities = masked(
        "getCapabilities",
        function (this: MediaStreamTrack): MediaTrackCapabilities {
          const capabilities = nativeGetCapabilities.call(this);
          if (!issuedTracks.has(this)) return capabilities;
          return {
            ...capabilities,
            autoGainControl: [true, false],
            channelCount: { max: 1, min: 1 },
            deviceId: micDeviceId,
            echoCancellation: [true, false],
            groupId: micGroupId,
            noiseSuppression: [true, false],
            sampleRate: { max: MIC_SAMPLE_RATE, min: MIC_SAMPLE_RATE },
            sampleSize: { max: 16, min: 16 },
          };
        },
        nativeGetCapabilities,
      );
    }
  };
  const issueTrack = (): MediaStreamTrack => {
    getHub();
    const raw = micOut.stream.getAudioTracks()[0]!;
    hookTrackPrototype(raw);
    const track = raw.clone();
    micTracks += 1;
    issuedTracks.set(track, { stopped: false });
    return track;
  };
  const devices = target.navigator.mediaDevices as MediaDevices | undefined;
  if (devices !== undefined) {
    const nativeGetUserMedia = devices.getUserMedia.bind(devices);
    const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
      if (!constraints?.audio) return nativeGetUserMedia(constraints);
      if (!(await openMic()))
        throw new DOMException("The microphone was not allowed", "NotAllowedError");
      const stream = constraints.video
        ? await nativeGetUserMedia({ video: constraints.video })
        : new NativeMediaStream();
      stream.addTrack(issueTrack());
      return stream;
    };
    // Hardening: on the prototype, where the browser has it, and looking like its own method.
    const owner = Object.getPrototypeOf(devices) as MediaDevices | null;
    if (mask !== undefined && owner !== null && typeof owner.getUserMedia === "function")
      owner.getUserMedia = masked("getUserMedia", getUserMedia, owner.getUserMedia);
    else devices.getUserMedia = getUserMedia;

    if (mask !== undefined && typeof devices.enumerateDevices === "function") {
      const nativeEnumerate = devices.enumerateDevices.bind(devices);
      const enumerateDevices = async (): Promise<MediaDeviceInfo[]> => {
        const list = await nativeEnumerate();
        if (!micGrantedOnce) return list;
        hookDeviceInfoPrototype();
        const existingAudio = list.find((item) => item.kind === "audioinput");
        if (existingAudio) {
          maskedDevices.add(existingAudio);
          return list;
        }
        const proto =
          (
            target as unknown as {
              InputDeviceInfo?: { prototype: object };
              MediaDeviceInfo?: { prototype: object };
            }
          ).InputDeviceInfo?.prototype ??
          (target as unknown as { MediaDeviceInfo?: { prototype: object } }).MediaDeviceInfo
            ?.prototype ??
          Object.prototype;
        const synthetic = Object.create(proto) as MediaDeviceInfo;
        maskedDevices.add(synthetic);
        return [synthetic, ...list];
      };
      if (owner !== null && typeof owner.enumerateDevices === "function")
        owner.enumerateDevices = masked(
          "enumerateDevices",
          enumerateDevices,
          owner.enumerateDevices,
        );
      else devices.enumerateDevices = enumerateDevices;
    }
  }
  const permissionsProto = (target as unknown as { Permissions?: { prototype: Permissions } })
    .Permissions?.prototype;
  if (
    mask !== undefined &&
    permissionsProto !== undefined &&
    typeof permissionsProto.query === "function"
  ) {
    const nativeQuery = permissionsProto.query;
    const query = function (this: Permissions, descriptor: PermissionDescriptor) {
      const result = nativeQuery.apply(this, [descriptor]);
      const name = (descriptor as { name?: unknown } | null | undefined)?.name;
      if (name !== "microphone") return result;
      return result.then((status) => {
        const protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(status), "state");
        const nativeGetState = protoDesc?.get;
        const stateGetter = () =>
          micGrantedOnce
            ? "granted"
            : nativeGetState
              ? (nativeGetState.call(status) as PermissionState)
              : status.state;
        Object.defineProperty(status, "state", {
          get: mask.asNativeNamed(stateGetter, "get state", 0) as () => PermissionState,
          configurable: true,
        });
        micStatuses.add(status);
        return status;
      });
    };
    permissionsProto.query = masked("query", query, nativeQuery);
  }
  target.addEventListener("pagehide", () => {
    if (micOpen) send({ mic: false });
  });

  return {
    receive(value) {
      const message = value as Partial<VoiceIn & { state: boolean; pcm: string }>;
      if (typeof message.state === "boolean") {
        micOpen = message.state;
        if (message.state && !micGrantedOnce) {
          micGrantedOnce = true;
          hookDeviceInfoPrototype();
          for (const status of micStatuses) {
            try {
              target.EventTarget.prototype.dispatchEvent.call(status, new target.Event("change"));
            } catch {
              // Ignore detached status listeners.
            }
          }
        }
        for (const answer of [...micWaiters]) answer(message.state);
        return;
      }
      if (typeof message.pcm !== "string" || !micOpen) return;
      const context = getHub();
      const samples = decodeVoiceSamples(message.pcm);
      const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      nativeConnect.call(source, micOut);
      const now = context.currentTime;
      if (nextMicAt < now || nextMicAt > now + MIC_MAX_LAG_S) nextMicAt = now + MIC_LEAD_S;
      source.start(nextMicAt);
      nextMicAt += buffer.duration;
    },
  };
}
