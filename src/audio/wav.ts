// PCM WAV, read and written without a library. A bank of sounds holds WAV
// files; the sound track of a shot is written as one. Both directions are pure
// functions of their bytes.
//
// Read: RIFF/WAVE with integer PCM of 8, 16, 24 or 32 bits or IEEE float of 32
// or 64 bits, also in the "extensible" form of the header; one or two
// channels; any sample rate. Compressed WAV (ADPCM, MP3 in a WAV) and other
// containers are not read: convert them first.

export class WavError extends Error {}

export interface Wav {
  /** Samples per second. */
  readonly rate: number;
  /** One array per channel, values in -1..1: one for mono, two for stereo. */
  readonly channels: readonly Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** Decodes a WAV file. `name` is used in the messages. */
export function readWav(bytes: Uint8Array, name = 'the file'): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new WavError(`${name} is not a WAV file (no RIFF/WAVE header); a bank of sounds holds PCM WAV files`);
  }
  let format = 0;
  let channelCount = 0;
  let rate = 0;
  let bits = 0;
  let blockAlign = 0;
  let data: { at: number; size: number } | null = null;
  // The chunks of the file: "fmt " says how the samples are stored, "data" holds them; others are passed over.
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new WavError(`${name}: the "fmt " chunk is cut short`);
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bits = view.getUint16(body + 14, true);
      // The extensible header keeps the real format in the first two bytes of its sub-format.
      if (format === FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= bytes.length) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, bytes.length - body) };
      break;
    }
    at = body + size + (size % 2);
  }
  if (format === 0) throw new WavError(`${name} has no "fmt " chunk before its data`);
  if (!data) throw new WavError(`${name} has no "data" chunk`);
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new WavError(`${name} is a compressed WAV (format ${format}); only PCM (integer or float) is read: convert it to PCM WAV`);
  }
  if (channelCount !== 1 && channelCount !== 2) throw new WavError(`${name} has ${channelCount} channels; a sound is mono or stereo`);
  if (!(rate >= 4000 && rate <= 384000)) throw new WavError(`${name} has a sample rate of ${rate} Hz; 4000 to 384000 Hz is read`);
  const bytesPer = bits / 8;
  const okBits = format === FORMAT_PCM ? [8, 16, 24, 32].includes(bits) : [32, 64].includes(bits);
  if (!okBits || blockAlign !== bytesPer * channelCount) {
    throw new WavError(`${name}: ${bits}-bit ${format === FORMAT_PCM ? 'integer' : 'float'} samples in blocks of ${blockAlign} bytes are not read (integer 8, 16, 24, 32; float 32, 64)`);
  }
  const frames = Math.floor(data.size / blockAlign);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0, at = data.at; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++, at += bytesPer) {
      let v: number;
      if (format === FORMAT_FLOAT) v = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bits === 8) v = (bytes[at]! - 128) / 128;
      else if (bits === 16) v = view.getInt16(at, true) / 32768;
      else if (bits === 24) v = ((view.getInt8(at + 2) << 16) | (bytes[at + 1]! << 8) | bytes[at]!) / 8388608;
      else v = view.getInt32(at, true) / 2147483648;
      channels[ch]![i] = Number.isFinite(v) ? v : 0;
    }
  }
  return { rate, channels };
}

/**
 * Encodes channels of the same length as a PCM WAV: 16 or 24 bits, or 32-bit
 * float. Integer samples are rounded to the nearest step and held within -1..1.
 */
export function writeWav(channels: readonly ArrayLike<number>[], rate: number, bits: 16 | 24 | 32 = 24): Uint8Array {
  const channelCount = channels.length;
  if (channelCount !== 1 && channelCount !== 2) throw new WavError(`a WAV of ${channelCount} channels is not written; one or two`);
  const frames = channels[0]!.length;
  if (channels.some((c) => c.length !== frames)) throw new WavError('the channels of a WAV must have the same length');
  const bytesPer = bits / 8;
  const size = frames * channelCount * bytesPer;
  const out = new Uint8Array(44 + size);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bits === 32 ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channelCount * bytesPer, true);
  view.setUint16(32, channelCount * bytesPer, true);
  view.setUint16(34, bits, true);
  tag(36, 'data');
  view.setUint32(40, size, true);
  const top = bits === 16 ? 32767 : 8388607;
  for (let i = 0, at = 44; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++, at += bytesPer) {
      const v = channels[ch]![i]!;
      if (bits === 32) {
        view.setFloat32(at, v, true);
        continue;
      }
      const q = Math.round(Math.max(-1, Math.min(1, v)) * top);
      if (bits === 16) view.setInt16(at, q, true);
      else {
        out[at] = q & 0xff;
        out[at + 1] = (q >> 8) & 0xff;
        out[at + 2] = (q >> 16) & 0xff;
      }
    }
  }
  return out;
}
