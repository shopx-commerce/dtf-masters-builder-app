import { useCallback, useEffect, useRef } from "react";
import { isTrustedShellMessage, sanitizeShellUploadUrl } from "@/lib/shell-message";
import { isTrustedCartStatus } from "@/lib/cart-submit-token";
import {
  ADD_TO_CART_STALL_MIN_MS_NEW,
  ADD_TO_CART_STALL_MIN_MS_UPDATE,
  ADD_TO_CART_STALL_MS_PER_MB,
} from "./constants";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}) => void;

export function useAddToCartStall({
  toast,
  isUpdateFlow,
  setIsAddingToCart,
  setIsProcessing,
  setIsUpdateFlow,
  setAddToCartProgressLabel,
  addToCartInFlightRef,
}: {
  toast: ToastFn;
  isUpdateFlow: boolean;
  setIsAddingToCart: (v: boolean) => void;
  setIsProcessing: (v: boolean) => void;
  setIsUpdateFlow: (v: boolean) => void;
  setAddToCartProgressLabel: (v: string | undefined) => void;
  addToCartInFlightRef: { current: boolean };
}) {
  const addToCartStallTimeoutRef = useRef<number | null>(null);
  const lastAddToCartPngBytesRef = useRef<number>(0);
  const shellUploadUrlRef = useRef<string | null>(null);

  const refreshAddToCartStallTimeout = useCallback((pngBytes?: number) => {
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
    }
    const mb = Math.max(1, (pngBytes || 0) / (1024 * 1024));
    const minMs = isUpdateFlow ? ADD_TO_CART_STALL_MIN_MS_UPDATE : ADD_TO_CART_STALL_MIN_MS_NEW;
    const stallMs = Math.max(minMs, Math.ceil(mb * ADD_TO_CART_STALL_MS_PER_MB));
    addToCartStallTimeoutRef.current = window.setTimeout(() => {
      addToCartInFlightRef.current = false;
      setIsAddingToCart(false);
      setIsProcessing(false);
      setIsUpdateFlow(false);
      addToCartStallTimeoutRef.current = null;
      toast({
        title: isUpdateFlow ? 'Update stalled' : 'Add to cart stalled',
        description: `No upload status received for ${Math.round(stallMs / 60_000)} minutes. Please refresh and try again.`,
        variant: 'destructive',
      });
    }, stallMs);
  }, [toast, isUpdateFlow, setIsAddingToCart, setIsProcessing, setIsUpdateFlow]);

  useEffect(() => {
    const onShellConfig = (e: MessageEvent) => {
      if (e.data?.type !== 'dtf-builder-shell-config') return;
      if (!isTrustedShellMessage(e, 'shell-config')) return;
      if (typeof e.data.uploadUrl === 'string' && e.data.uploadUrl.trim()) {
        // The endpoint receives the customer's full-resolution production file,
        // so it is allow-listed even when the message itself looked genuine.
        // Rejecting leaves the ref null, which routes the upload through the
        // shell relay instead of an unknown host.
        const safeUploadUrl = sanitizeShellUploadUrl(e.data.uploadUrl);
        if (safeUploadUrl) shellUploadUrlRef.current = safeUploadUrl;
      }
    };
    window.addEventListener('message', onShellConfig);
    return () => window.removeEventListener('message', onShellConfig);
  }, []);

  useEffect(() => {
    const onCartStatus = (e: MessageEvent) => {
      if (e.data?.type !== 'dtf-builder-cart-status') return;
      if (!isTrustedShellMessage(e, 'cart-status')) return;
      // Must belong to a submit this tab made, so a spoofed status cannot fake
      // an "Added to cart" toast, drop the spinner mid-upload, or hold the
      // stall watchdog open indefinitely.
      if (!isTrustedCartStatus(e.data.requestId, e.data.status)) return;
      if (e.data.status === 'progress' || e.data.status === 'uploaded') {
        refreshAddToCartStallTimeout(lastAddToCartPngBytesRef.current || undefined);
      }
      if (e.data.status === 'uploaded') {
        const msg = typeof e.data.message === 'string' ? e.data.message : (isUpdateFlow ? 'Updating design...' : 'Adding product to cart...');
        toast({ title: 'Image uploaded', description: msg.slice(0, 180) });
      }
      if (e.data.status === 'error' || e.data.status === 'done') {
        if (addToCartStallTimeoutRef.current != null) {
          window.clearTimeout(addToCartStallTimeoutRef.current);
          addToCartStallTimeoutRef.current = null;
        }
        const wasUpdateFlow = isUpdateFlow;
        addToCartInFlightRef.current = false;
        setIsAddingToCart(false);
        setIsProcessing(false);
        setIsUpdateFlow(false);
        setAddToCartProgressLabel(undefined);
        if (e.data.status === 'done') {
          const doneMsg = typeof e.data.message === 'string' ? e.data.message : (wasUpdateFlow ? 'Design updated' : 'Added to cart');
          toast({ title: wasUpdateFlow ? 'Design updated' : 'Added to cart', description: doneMsg.slice(0, 180) });
        }
      }
      if (e.data.status === 'error') {
        const detail = typeof e.data.message === 'string' ? e.data.message : (isUpdateFlow ? 'Could not update design' : 'Could not add to cart');
        toast({ title: isUpdateFlow ? 'Update failed' : 'Add to cart failed', description: detail.slice(0, 180), variant: 'destructive' });
      }
    };
    window.addEventListener('message', onCartStatus);
    return () => window.removeEventListener('message', onCartStatus);
  }, [toast, isUpdateFlow, refreshAddToCartStallTimeout, setIsAddingToCart, setIsProcessing, setIsUpdateFlow, setAddToCartProgressLabel]);

  const clearStallTimeout = useCallback(() => {
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
      addToCartStallTimeoutRef.current = null;
    }
  }, []);

  return {
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
    clearStallTimeout,
  };
}
