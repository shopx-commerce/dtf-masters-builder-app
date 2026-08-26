/**
 * Lossless single-ink PNG recolouring. The pixels are decoded and re-encoded
 * (so the PNG byte stream itself is not retained), but alpha samples are copied
 * without calculation. A visible source is deliberately restricted to one RGB
 * ink: every visible pixel must have exactly the same straight RGB samples.
 * Any variation is ambiguous shading, a matte, or more than one ink. Neutral
 * inks (black, white, and gray) are valid; only variation within an ink is
 * ambiguous.
 */
import { convertIndexedToRgb, decode, encode } from "fast-png";
import type { DecodedPng } from "fast-png";
import {
  COLOR_CHANGE_MAX_DECODED_PIXELS,
  COLOR_CHANGE_MAX_SOURCE_BYTES,
} from "./color-change-limits";

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface SourceCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ColorChangeReason =
  | "empty-input"
  | "not-png"
  | "invalid-png"
  | "animated-png"
  | "unsupported-bit-depth"
  | "no-alpha-channel"
  | "unsupported-format"
  | "image-too-large"
  | "invalid-crop"
  | "grayscale-ambiguity"
  | "no-visible-pixels"
  | "multiple-visible-colors";

export interface ColorChangeIneligible {
  eligible: false;
  reason: ColorChangeReason;
  width?: number;
  height?: number;
}

export interface ColorChangeEligible {
  eligible: true;
  sourceColor: RgbColor;
  width: number;
  height: number;
}

export type ColorChangeAnalysis = ColorChangeEligible | ColorChangeIneligible;

export interface DecodedColorChangePng {
  width: number;
  height: number;
  /** RGBA pixels for the requested crop. */
  data: Uint8Array;
}

export type RecolorPngResult =
  | { ok: true; png: Uint8Array; sourceColor: RgbColor; width: number; height: number }
  | { ok: false; reason: ColorChangeReason };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

interface PngHeader {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  animated: boolean;
}

function readHeader(bytes: Uint8Array): PngHeader | ColorChangeReason {
  if (!bytes.length) return "empty-input";
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return "not-png";
  }
  let offset = 8;
  let header: PngHeader | undefined;
  let animated = false;
  while (offset + 12 <= bytes.length) {
    const length = (((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0);
    const end = offset + 12 + length;
    if (end > bytes.length || end < offset) return "invalid-png";
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === "IHDR") {
      if (length !== 13 || header) return "invalid-png";
      const width = (((bytes[offset + 8] * 0x1000000) + ((bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11])) >>> 0);
      const height = (((bytes[offset + 12] * 0x1000000) + ((bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15])) >>> 0);
      header = { width, height, depth: bytes[offset + 16], colorType: bytes[offset + 17], animated: false };
    } else if (type === "acTL") {
      animated = true;
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }
  if (!header || !header.width || !header.height) return "invalid-png";
  header.animated = animated;
  return header;
}

function cropIsValid(crop: SourceCrop | undefined, width: number, height: number): crop is SourceCrop {
  return Boolean(
    crop &&
    Number.isInteger(crop.x) && Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) && Number.isInteger(crop.height) &&
    crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 &&
    crop.x + crop.width <= width && crop.y + crop.height <= height,
  );
}

function normalizeCrop(crop: SourceCrop | undefined, width: number, height: number): SourceCrop | undefined {
  if (!crop) return { x: 0, y: 0, width, height };
  return cropIsValid(crop, width, height) ? crop : undefined;
}

function rgbaFromDecoded(image: DecodedPng, colorType: number): Uint8Array | ColorChangeReason {
  if (image.depth !== 8) return "unsupported-bit-depth";
  if (colorType === 4 && image.channels === 2 && image.data instanceof Uint8Array) {
    const rgba = new Uint8Array(image.width * image.height * 4);
    for (let source = 0, target = 0; source < image.data.length; source += 2, target += 4) {
      const gray = image.data[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = image.data[source + 1];
    }
    return rgba;
  }
  if (colorType === 6 && image.channels === 4 && image.data instanceof Uint8Array) return image.data;
  if (colorType === 3 && image.palette && image.palette.some(color => color.length === 4)) {
    const converted = convertIndexedToRgb(image);
    return converted;
  }
  return colorType === 3 || colorType === 0 || colorType === 2 ? "no-alpha-channel" : "unsupported-format";
}

/** Decodes a supported PNG into the exact RGBA pixels in `crop`. */
export function decodeColorChangePng(bytes: Uint8Array, crop?: SourceCrop): DecodedColorChangePng | ColorChangeIneligible {
  const header = readHeader(bytes);
  if (typeof header === "string") return { eligible: false, reason: header };
  if (bytes.byteLength > COLOR_CHANGE_MAX_SOURCE_BYTES || header.width * header.height > COLOR_CHANGE_MAX_DECODED_PIXELS) {
    return { eligible: false, reason: "image-too-large", width: header.width, height: header.height };
  }
  if (header.animated) return { eligible: false, reason: "animated-png", width: header.width, height: header.height };
  if (header.depth !== 8) return { eligible: false, reason: "unsupported-bit-depth", width: header.width, height: header.height };
  const normalizedCrop = normalizeCrop(crop, header.width, header.height);
  if (!normalizedCrop) return { eligible: false, reason: "invalid-crop", width: header.width, height: header.height };
  let decoded: DecodedPng;
  try {
    decoded = decode(bytes);
  } catch {
    return { eligible: false, reason: "invalid-png", width: header.width, height: header.height };
  }
  const rgba = rgbaFromDecoded(decoded, header.colorType);
  if (typeof rgba === "string") return { eligible: false, reason: rgba, width: header.width, height: header.height };
  if (rgba.length !== header.width * header.height * 4) {
    return { eligible: false, reason: "unsupported-format", width: header.width, height: header.height };
  }
  if (
    normalizedCrop.x === 0 && normalizedCrop.y === 0 &&
    normalizedCrop.width === header.width && normalizedCrop.height === header.height
  ) {
    return { width: header.width, height: header.height, data: rgba };
  }
  const data = new Uint8Array(normalizedCrop.width * normalizedCrop.height * 4);
  for (let row = 0; row < normalizedCrop.height; row++) {
    const sourceStart = ((normalizedCrop.y + row) * header.width + normalizedCrop.x) * 4;
    data.set(rgba.subarray(sourceStart, sourceStart + normalizedCrop.width * 4), row * normalizedCrop.width * 4);
  }
  return { width: normalizedCrop.width, height: normalizedCrop.height, data };
}

function analyzeDecoded(decoded: DecodedColorChangePng): ColorChangeAnalysis {
  let source: RgbColor | undefined;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset + 3] === 0) continue; // RGB below zero alpha is not visible.
    const color = { r: decoded.data[offset], g: decoded.data[offset + 1], b: decoded.data[offset + 2] };
    if (!source) source = color;
    else if (color.r !== source.r || color.g !== source.g || color.b !== source.b) {
      return { eligible: false, reason: "multiple-visible-colors", width: decoded.width, height: decoded.height };
    }
  }
  if (!source) return { eligible: false, reason: "no-visible-pixels", width: decoded.width, height: decoded.height };
  return { eligible: true, sourceColor: source, width: decoded.width, height: decoded.height };
}

/** Determines whether all non-transparent pixels are one unambiguous RGB ink. */
export function analyzeColorChangePng(bytes: Uint8Array, crop?: SourceCrop): ColorChangeAnalysis {
  const decoded = decodeColorChangePng(bytes, crop);
  return "eligible" in decoded ? decoded : analyzeDecoded(decoded);
}

function preservePhysicalResolution(source: Uint8Array, encoded: Uint8Array): Uint8Array {
  let offset = 8;
  let physicalChunk: Uint8Array | undefined;
  while (offset + 12 <= source.length) {
    const length = (((source[offset] * 0x1000000) + ((source[offset + 1] << 16) | (source[offset + 2] << 8) | source[offset + 3])) >>> 0);
    const end = offset + 12 + length;
    if (end > source.length || end < offset) break;
    const type = String.fromCharCode(source[offset + 4], source[offset + 5], source[offset + 6], source[offset + 7]);
    if (type === "pHYs" && length === 9) {
      physicalChunk = source.slice(offset, end);
      break;
    }
    offset = end;
  }
  if (!physicalChunk) return encoded;
  // fast-png emits IHDR first and no pHYs of its own. Put the original,
  // CRC-validated source chunk immediately after IHDR, before IDAT.
  const ihdrEnd = 33;
  const output = new Uint8Array(encoded.length + physicalChunk.length);
  output.set(encoded.subarray(0, ihdrEnd), 0);
  output.set(physicalChunk, ihdrEnd);
  output.set(encoded.subarray(ihdrEnd), ihdrEnd + physicalChunk.length);
  return output;
}

/** Replaces RGB on every visible pixel, preserving each crop alpha byte exactly. */
export function recolorPng(bytes: Uint8Array, target: RgbColor, crop?: SourceCrop): RecolorPngResult {
  if (![target.r, target.g, target.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new RangeError("Target color channels must be integers from 0 through 255.");
  }
  const decoded = decodeColorChangePng(bytes, crop);
  if ("eligible" in decoded) return { ok: false, reason: decoded.reason };
  const analysis = analyzeDecoded(decoded);
  if (!analysis.eligible) return { ok: false, reason: analysis.reason };
  const output = new Uint8Array(decoded.data);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] !== 0) {
      output[offset] = target.r;
      output[offset + 1] = target.g;
      output[offset + 2] = target.b;
    }
  }
  return {
    ok: true,
    png: preservePhysicalResolution(
      bytes,
      encode({ width: decoded.width, height: decoded.height, data: output, channels: 4, depth: 8 }),
    ),
    sourceColor: analysis.sourceColor,
    width: decoded.width,
    height: decoded.height,
  };
}