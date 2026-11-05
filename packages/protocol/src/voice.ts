/** Voice travels as mono 16-bit little-endian samples in base64, at one rate in both directions. */
export const VOICE_SAMPLE_RATE = 24_000;
const MAX_SAMPLE = 32_767;

export function encodeVoiceSamples(samples: Float32Array): string {
  let binary = "";
  for (const sample of samples) {
    const value = Math.round(Math.max(-1, Math.min(1, sample)) * MAX_SAMPLE) & 0xffff;
    binary += String.fromCharCode(value & 0xff, value >> 8);
  }
  return btoa(binary);
}

export function decodeVoiceSamples(encoded: string): Float32Array<ArrayBuffer> {
  const binary = atob(encoded);
  const samples = new Float32Array(binary.length >> 1);
  for (let index = 0; index < samples.length; index++) {
    const value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
    samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / MAX_SAMPLE;
  }
  return samples;
}
