/**
 * The viewer's side of Claude's microphone and sound: it records from this device when the remote
 * page asks to, and plays what the remote page plays. See agent/src/voice.ts for the other side.
 */
import type { TabId, Up } from "@mirror/protocol";
import { VOICE_SAMPLE_RATE, decodeVoiceSamples, encodeVoiceSamples } from "@mirror/protocol";

const CAPTURE_FRAME_SAMPLES = 2048;
/** Sound starts this far ahead, to ride out uneven arrival. */
const PLAY_LEAD_S = 0.15;
/** Further behind than this and catching up matters more than playing everything. */
const PLAY_MAX_LAG_S = 0.8;

/** Averages down to the voice rate, keeping its place between frames. */
export function createDownsampler(fromRate: number, toRate: number) {
  const step = fromRate / toRate;
  let carrySum = 0;
  let carryCount = 0;
  let position = 0;
  return (input: Float32Array): Float32Array => {
    if (fromRate === toRate) return input.slice();
    const output = new Float32Array(Math.ceil((input.length + carryCount) / step) + 1);
    let written = 0;
    for (const sample of input) {
      carrySum += sample;
      carryCount += 1;
      position += 1;
      if (position >= step) {
        output[written++] = carrySum / carryCount;
        carrySum = 0;
        carryCount = 0;
        position -= step;
      }
    }
    return output.subarray(0, written);
  };
}

type VoiceUp = Extract<Up, { t: "mic-pcm" | "mic-state" }>;

export interface VoiceLink {
  setSender(send: ((message: VoiceUp) => void) | null): void;
  play(encoded: string): void;
  setMic(tab: TabId, on: boolean): void;
  /** Browsers only start sound from a user's action, so every action tries again. */
  unlock(): void;
  dispose(): void;
}

export function createVoiceLink(): VoiceLink {
  let send: ((message: VoiceUp) => void) | null = null;
  let player: AudioContext | null = null;
  let nextPlayAt = 0;
  let wantedTab: TabId | null = null;
  let stopCapture: (() => void) | null = null;

  const getPlayer = (): AudioContext => {
    player ??= new AudioContext({ latencyHint: "interactive" });
    if (player.state === "suspended") void player.resume();
    return player;
  };

  const startCapture = async (tab: TabId): Promise<void> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (wantedTab === tab) wantedTab = null;
      send?.({ t: "mic-state", tab, ok: false });
      return;
    }
    if (wantedTab !== tab) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    void context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(CAPTURE_FRAME_SAMPLES, 1, 1);
    const downsample = createDownsampler(context.sampleRate, VOICE_SAMPLE_RATE);
    processor.onaudioprocess = (event) => {
      const samples = downsample(event.inputBuffer.getChannelData(0));
      if (samples.length > 0) send?.({ t: "mic-pcm", tab, pcm: encodeVoiceSamples(samples) });
    };
    source.connect(processor);
    // A processor only runs while connected to an output; it writes nothing to it.
    processor.connect(context.destination);
    stopCapture = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    };
    send?.({ t: "mic-state", tab, ok: true });
  };

  const endCapture = () => {
    wantedTab = null;
    stopCapture?.();
    stopCapture = null;
  };

  return {
    setSender(next) {
      send = next;
      // Without the connection nothing can leave this device, so the microphone goes off too.
      if (next === null) endCapture();
    },
    play(encoded) {
      const context = getPlayer();
      const samples = decodeVoiceSamples(encoded);
      const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const now = context.currentTime;
      if (nextPlayAt < now || nextPlayAt > now + PLAY_MAX_LAG_S) nextPlayAt = now + PLAY_LEAD_S;
      source.start(nextPlayAt);
      nextPlayAt += buffer.duration;
    },
    setMic(tab, on) {
      if (!on) {
        if (wantedTab === tab) endCapture();
        return;
      }
      if (wantedTab === tab) {
        if (stopCapture !== null) send?.({ t: "mic-state", tab, ok: true });
        return;
      }
      endCapture();
      wantedTab = tab;
      void startCapture(tab);
    },
    unlock() {
      getPlayer();
    },
    dispose() {
      endCapture();
      void player?.close();
      player = null;
    },
  };
}
