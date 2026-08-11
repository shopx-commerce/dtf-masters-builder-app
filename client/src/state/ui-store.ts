/**
 * Zustand-backed UI-mode store.
 *
 * Owns the "toggle-shaped" UI state that used to sit in the giant
 * `useImageEditorModelStateDesign` bag:
 *
 *   - `contextMenu`           right-click popover position + target design
 *   - `mobilePanel`           which pane the mobile layout is showing
 *   - `showDesignInfo`        layers panel open/closed
 *   - `selectionZoomActive`   preview zoom-to-selection mode
 *   - `panModeActive`         preview pan-only mode
 *   - `wandDeleteModeActive`  magic-wand mode
 *   - `activeSpotChannel`     fluorescent channel currently being edited
 *   - `spotPreviewData`       spot-color preview payload for the canvas
 *   - `cropModalDesignId`     which design (if any) is being cropped
 *
 * Every one of these values used to regenerate the entire editor context
 * bag on toggle, which re-ran the model hook and invalidated every
 * `useCallback` that closed over any of them. Right-clicking a design,
 * flipping to preview on mobile, or hovering a fluorescent channel would
 * cascade a re-render through preview-section, controls-section, and the
 * action toolbar.
 *
 * Moved here, they're read via granular selectors — so the mode toggle
 * only re-renders the pieces of UI that actually care, and model
 * callbacks read the value imperatively via `getUiSnapshot()` at click
 * time. That means:
 *
 *   - Right-click: only the popover renders. The model does not re-run,
 *     so `handleCropDesign`, `handleAddToCart`, etc. keep their identity.
 *   - Mobile-panel flip: only the panel container re-renders.
 *   - Spot-channel hover: only the fluor panel + preview overlay
 *     re-render — the toolbar / layers / DPI badge stay put.
 *
 * All of this state is UI-only. None of it feeds the export pipeline or
 * the Shopify variant/cart payload, so the migration cannot affect PNG
 * quality or Shopify embedding.
 */

import { useMemo } from "react";
import { create } from "zustand";
import type { SpotPreviewData } from "@/components/controls-section";

type ContextMenuState = { x: number; y: number; designId: string } | null;
type MobilePanel = "controls" | "preview";

interface UiState {
  contextMenu: ContextMenuState;
  mobilePanel: MobilePanel;
  showDesignInfo: boolean;
  selectionZoomActive: boolean;
  panModeActive: boolean;
  wandDeleteModeActive: boolean;
  activeSpotChannel: string | null;
  spotPreviewData: SpotPreviewData;
  cropModalDesignId: string | null;

  setContextMenu: (menu: ContextMenuState) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setShowDesignInfo: (
    valueOrUpdater: boolean | ((prev: boolean) => boolean),
  ) => void;
  setSelectionZoomActive: (
    valueOrUpdater: boolean | ((prev: boolean) => boolean),
  ) => void;
  setPanModeActive: (
    valueOrUpdater: boolean | ((prev: boolean) => boolean),
  ) => void;
  setWandDeleteModeActive: (
    valueOrUpdater: boolean | ((prev: boolean) => boolean),
  ) => void;
  setActiveSpotChannel: (channel: string | null) => void;
  setSpotPreviewData: (data: SpotPreviewData) => void;
  setCropModalDesignId: (id: string | null) => void;
}

const DEFAULT_SPOT_PREVIEW: SpotPreviewData = { enabled: false, colors: [] };

export const useUiStore = create<UiState>((set, get) => ({
  contextMenu: null,
  mobilePanel: "controls",
  showDesignInfo: true,
  selectionZoomActive: false,
  panModeActive: false,
  wandDeleteModeActive: false,
  activeSpotChannel: null,
  spotPreviewData: DEFAULT_SPOT_PREVIEW,
  cropModalDesignId: null,

  setContextMenu: (menu) => set({ contextMenu: menu }),
  setMobilePanel: (panel) => set({ mobilePanel: panel }),
  setShowDesignInfo: (valueOrUpdater) =>
    set({
      showDesignInfo:
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(get().showDesignInfo)
          : valueOrUpdater,
    }),
  setSelectionZoomActive: (valueOrUpdater) =>
    set({
      selectionZoomActive:
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(get().selectionZoomActive)
          : valueOrUpdater,
    }),
  setPanModeActive: (valueOrUpdater) =>
    set({
      panModeActive:
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(get().panModeActive)
          : valueOrUpdater,
    }),
  setWandDeleteModeActive: (valueOrUpdater) =>
    set({
      wandDeleteModeActive:
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(get().wandDeleteModeActive)
          : valueOrUpdater,
    }),
  setActiveSpotChannel: (channel) => set({ activeSpotChannel: channel }),
  setSpotPreviewData: (data) => set({ spotPreviewData: data }),
  setCropModalDesignId: (id) => set({ cropModalDesignId: id }),
}));

// --------------------------------------------------------------------------
// Granular subscription hooks
// --------------------------------------------------------------------------

/** Subscribe to `contextMenu` only. Fires when the popover opens/closes. */
export const useContextMenu = () => useUiStore((s) => s.contextMenu);
/** Subscribe to `mobilePanel` only. */
export const useMobilePanel = () => useUiStore((s) => s.mobilePanel);
/** Subscribe to `showDesignInfo` only. */
export const useShowDesignInfo = () => useUiStore((s) => s.showDesignInfo);
/** Subscribe to `selectionZoomActive` only. */
export const useSelectionZoomActive = () =>
  useUiStore((s) => s.selectionZoomActive);
/** Subscribe to `panModeActive` only. */
export const usePanModeActive = () => useUiStore((s) => s.panModeActive);
/** Subscribe to `wandDeleteModeActive` only. */
export const useWandDeleteModeActive = () =>
  useUiStore((s) => s.wandDeleteModeActive);
/** Subscribe to `activeSpotChannel` only. */
export const useActiveSpotChannel = () =>
  useUiStore((s) => s.activeSpotChannel);
/** Subscribe to `spotPreviewData` only. */
export const useSpotPreviewData = () => useUiStore((s) => s.spotPreviewData);
/** Subscribe to `cropModalDesignId` only. */
export const useCropModalDesignId = () =>
  useUiStore((s) => s.cropModalDesignId);

/**
 * Stable-identity bundle of every UI-store action. Zustand guarantees
 * each action reference never changes, so `useMemo` here just prevents
 * the wrapper object identity from churning between renders — safe to
 * pass into `useCallback` / `useEffect` dependency arrays.
 */
export function useUiActions() {
  const setContextMenu = useUiStore((s) => s.setContextMenu);
  const setMobilePanel = useUiStore((s) => s.setMobilePanel);
  const setShowDesignInfo = useUiStore((s) => s.setShowDesignInfo);
  const setSelectionZoomActive = useUiStore((s) => s.setSelectionZoomActive);
  const setPanModeActive = useUiStore((s) => s.setPanModeActive);
  const setWandDeleteModeActive = useUiStore((s) => s.setWandDeleteModeActive);
  const setActiveSpotChannel = useUiStore((s) => s.setActiveSpotChannel);
  const setSpotPreviewData = useUiStore((s) => s.setSpotPreviewData);
  const setCropModalDesignId = useUiStore((s) => s.setCropModalDesignId);
  return useMemo(
    () => ({
      setContextMenu,
      setMobilePanel,
      setShowDesignInfo,
      setSelectionZoomActive,
      setPanModeActive,
      setWandDeleteModeActive,
      setActiveSpotChannel,
      setSpotPreviewData,
      setCropModalDesignId,
    }),
    [
      setContextMenu,
      setMobilePanel,
      setShowDesignInfo,
      setSelectionZoomActive,
      setPanModeActive,
      setWandDeleteModeActive,
      setActiveSpotChannel,
      setSpotPreviewData,
      setCropModalDesignId,
    ],
  );
}

/**
 * Non-reactive snapshot for imperative handlers. Read at click time so
 * callbacks don't need the value in their `useCallback` deps — that keeps
 * callback identity stable across UI-toggle churn.
 *
 * Never call at render time.
 */
export function getUiSnapshot(): {
  contextMenu: ContextMenuState;
  spotPreviewData: SpotPreviewData;
  cropModalDesignId: string | null;
  activeSpotChannel: string | null;
  wandDeleteModeActive: boolean;
  mobilePanel: MobilePanel;
} {
  const s = useUiStore.getState();
  return {
    contextMenu: s.contextMenu,
    spotPreviewData: s.spotPreviewData,
    cropModalDesignId: s.cropModalDesignId,
    activeSpotChannel: s.activeSpotChannel,
    wandDeleteModeActive: s.wandDeleteModeActive,
    mobilePanel: s.mobilePanel,
  };
}
