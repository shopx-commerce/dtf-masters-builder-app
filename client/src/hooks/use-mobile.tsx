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
 * Widest viewport that still gets the phone layout while held upright.
 *
 * A tablet in portrait has the phone's problem, not the desktop's: the sidebar
 * is a fixed 320px of an ~800px screen and the toolbar has to wrap into six
 * rows, which between them leave the canvas a ~450px strip less than half the
 * window tall. The gangsheet is the thing being worked on and it ends up the
 * smallest element on screen — a 744px iPad Mini on the phone layout renders
 * the sheet 700px wide, while a *larger* 820px iPad on the desktop layout
 * renders it 457px.
 *
 * Every iPad in portrait is at most 1024 wide (Pro 12.9") and every iPad in
 * landscape is at least 1024 wide, so orientation is what actually separates
 * "standing up" from "lying down"; this ceiling only keeps a genuinely large
 * portrait display on the desktop layout. Landscape tablets keep the desktop
 * layout, where there is room across for the sidebar.
 */
export const PORTRAIT_TABLET_MAX_WIDTH = 1100

/**
 * Whether the device has a touch screen at all.
 *
 * `any-pointer`, not `pointer`, for the reason given in `tailwind.config.ts`: an
 * iPad with a Magic Keyboard still wants the tablet answer.
 */
function hasCoarsePointer(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(any-pointer: coarse)").matches
}

/**
 * Width alone cannot tell 844×390 (a phone on its side) from 844×1180 (a
 * tablet), so height decides too.
 *
 * The portrait clause additionally requires a touch screen, because "taller than
 * wide" is a safe reading of a device but not of a *frame*. On the storefront
 * this builder is an iframe, and `window.innerWidth` is the iframe's width; a
 * theme that sizes the frame to its content rather than to the viewport hands a
 * desktop shopper something like 1000×1400, which is portrait and under the
 * ceiling and would otherwise take the phone layout on a mouse-driven machine.
 * The shell can correct the width (`hooks/use-layout-viewport.ts`), but
 * `docs/storefront-embed.md` treats that as an upgrade a theme may not have
 * made, so this cannot depend on it. A real portrait tablet is coarse; a desktop
 * in a tall frame is not.
 */
export function isCompactViewport(width: number, height: number): boolean {
  if (height > 0 && height < SHORT_VIEWPORT_BREAKPOINT) return true
  if (width < MOBILE_BREAKPOINT) return true
  return height > width && width < PORTRAIT_TABLET_MAX_WIDTH && hasCoarsePointer()
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    // A comma in a media query list is an OR, so this single listener fires on
    // every transition that can change the answer. A rotation that swaps which
    // of the two conditions is being met (portrait 390×844 → landscape 844×390)
    // fires nothing, but the answer is `true` on both sides of it. The third
    // clause is what catches a tablet being turned, where the answer does flip.
    const mql = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px), (max-height: ${SHORT_VIEWPORT_BREAKPOINT - 1}px), (orientation: portrait) and (max-width: ${PORTRAIT_TABLET_MAX_WIDTH - 1}px) and (any-pointer: coarse)`,
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
