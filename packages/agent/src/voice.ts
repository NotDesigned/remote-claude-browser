/**
 * Claude's microphone and sound, on a browser that has neither.
 *
 * The real browser runs on a server, so the page's microphone is fed from the viewer's device and
 * what the page plays is sent back to it. Doing this inside the page keeps every client's audio on
 * its own connection, where a shared system sound device would mix them together. Whole-tab capture
 * was the alternative, but Chromium shows a sharing bar with it, which changes the page's height.
 */
import { VOICE_SAMPLE_RATE, decodeVoiceSamples, encodeVoiceSamples } from "@mirror/protocol";

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
): VoiceBridge {
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
  target.AudioNode.prototype.connect = connect as typeof AudioNode.prototype.connect;
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
  target.AudioNode.prototype.disconnect = disconnect as typeof AudioNode.prototype.disconnect;

  // Sound from media elements, unless the page routes the element through Web Audio above.
  const elementGains = new WeakMap<HTMLMediaElement, GainNode>();
  const routedElements = new WeakSet<HTMLMediaElement>();
  const nativeElementSource = target.AudioContext.prototype.createMediaElementSource;
  target.AudioContext.prototype.createMediaElementSource = function (element) {
    routedElements.add(element);
    const gain = elementGains.get(element);
    if (gain) gain.gain.value = 0;
    return nativeElementSource.call(this, element);
  };
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
  target.HTMLMediaElement.prototype.play = function () {
    try {
      tapElement(this);
    } catch {
      // Playback matters more than hearing it here; the page must never see this fail.
    }
    return nativePlay.call(this);
  };

  // The microphone.
  let micOpen = false;
  let micTracks = 0;
  const micWaiters: ((granted: boolean) => void)[] = [];
  let nextMicAt = 0;
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
  const issueTrack = (): MediaStreamTrack => {
    getHub();
    const track = micOut.stream.getAudioTracks()[0]!.clone();
    micTracks += 1;
    const nativeStop = track.stop;
    let stopped = false;
    track.stop = function () {
      nativeStop.call(track);
      if (stopped) return;
      stopped = true;
      micTracks -= 1;
      if (micTracks > 0) return;
      micOpen = false;
      send({ mic: false });
    };
    return track;
  };
  const devices = target.navigator.mediaDevices as MediaDevices | undefined;
  if (devices !== undefined) {
    const nativeGetUserMedia = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) return nativeGetUserMedia(constraints);
      if (!(await openMic()))
        throw new DOMException("The microphone was not allowed", "NotAllowedError");
      const stream = constraints.video
        ? await nativeGetUserMedia({ video: constraints.video })
        : new NativeMediaStream();
      stream.addTrack(issueTrack());
      return stream;
    };
  }
  // Device enumeration and permission state belong to Chromium. The viewer authorizes its own
  // microphone separately; inventing devices or PermissionStatus objects changes Web API semantics.
  target.addEventListener("pagehide", () => {
    if (micOpen) send({ mic: false });
  });

  return {
    receive(value) {
      const message = value as Partial<VoiceIn & { state: boolean; pcm: string }>;
      if (typeof message.state === "boolean") {
        micOpen = message.state;
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
