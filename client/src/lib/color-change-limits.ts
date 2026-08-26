/**
 * Ceilings for the whole-image fallback decoder, not for the feature.
 *
 * These are what a decode-recolour-encode of one buffer costs: 40 megapixels is
 * already 160 MB of RGBA before the copy the recolour writes into and whatever
 * the encoder allocates. The streaming path in `png-recolor-stream` is bounded
 * by rows rather than by the image, so it does not consult them — they only
 * apply to files that path cannot walk (interlaced PNGs) and to browsers
 * without the compression streams.
 */
export const COLOR_CHANGE_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const COLOR_CHANGE_MAX_DECODED_PIXELS = 40_000_000;
