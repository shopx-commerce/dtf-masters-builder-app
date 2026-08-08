import * as React from "react"

export const MOBILE_BREAKPOINT = 768

/**
 * Below this viewport height the desktop layout has nowhere to put itself.
 *
 * Between 768 and 1023 the editor renders its sidebar `w-full` above the canvas
 * (`lg:` is where the row layout starts), which is right for a tablet held
 * upright and fatal for a phone on its side: the canvas lands ~790px down a
 * viewport that is 390px tall and cannot scroll.
 *
 * Phones in landscape are 375–430 CSS px tall (iPhone SE through 15 Pro Max).
 * The shortest tablet in any orientation is an iPad Mini at 744. 500 clears the
 * tallest phone landscape by 70px and undershoots the shortest tablet by 244px,
 * so no real device sits near the line. A desktop window deliberately dragged
 * under 500px tall also lands here, which is the right answer for the same
 * reason — the stacked layout does not fit there either.
 */
export const SHORT_VIEWPORT_BREAKPOINT = 500

/**
 * Width alone cannot tell 844×390 (a phone on its side) from 844×1180 (a
 * tablet), so height decides too.
 */
export function isCompactViewport(width: number, height: number): boolean {
  return width < MOBILE_BREAKPOINT || height < SHORT_VIEWPORT_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    // A comma in a media query list is an OR, so this single listener fires on
    // every transition that can change the answer. A rotation that swaps which
    // of the two conditions is being met (portrait 390×844 → landscape 844×390)
    // fires nothing, but the answer is `true` on both sides of it.
    const mql = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px), (max-height: ${SHORT_VIEWPORT_BREAKPOINT - 1}px)`,
    )
    const onChange = () => {
      setIsMobile(isCompactViewport(window.innerWidth, window.innerHeight))
    }
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
