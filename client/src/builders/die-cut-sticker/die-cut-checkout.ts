import {

  canUseShellRelay,

  uploadProductionToR2,

} from "@/lib/r2-direct-upload";



export type DieCutShopifyVariant = {

  id: string;

  title: string;

  price?: string | null;

  width?: number | null;

  height?: number | null;

};



export type DieCutCheckoutInput = {

  pdfBase64: string;

  previewDataUrl?: string | null;

  stickerSizeLabel: string;

  widthInches: number;

  heightInches: number;

  quantity: number;

  outlineType: string;

  finish: string;

  lamination: string;

  displayTotal: number;

  variantId?: string | null;

  variants?: DieCutShopifyVariant[] | null;

  shopDomain?: string | null;

  productHandle?: string | null;

  imageName?: string | null;

  customerId?: string | null;

  customerEmail?: string | null;

  onProgress?: (message: string) => void;

};



export type DieCutCheckoutResult = {

  referenceCode: string;

  designUrl: string;

  productionUrl: string | null;

  previewUrl: string | null;

  usedShellAtc: boolean;

};



function postMessageToParent(message: Record<string, unknown>) {

  try {

    if (window.parent && window.parent !== window) {

      window.parent.postMessage(message, "*");

    }

  } catch {

    /* ignore */

  }

}



function waitForCartStatus(timeoutMs = 180_000): Promise<{ status: string; message?: string }> {

  return new Promise((resolve, reject) => {

    const timer = window.setTimeout(() => {

      window.removeEventListener("message", onMessage);

      reject(new Error("Add to cart timed out"));

    }, timeoutMs);

    const onMessage = (e: MessageEvent) => {

      const d = e.data;

      if (!d || typeof d !== "object") return;

      if ((d as { type?: string }).type !== "dtf-builder-cart-status") return;

      const status = String((d as { status?: string }).status || "");

      if (status === "done" || status === "error") {

        window.clearTimeout(timer);

        window.removeEventListener("message", onMessage);

        if (status === "error") {

          reject(new Error(String((d as { message?: string }).message || "Add to cart failed")));

          return;

        }

        resolve({ status, message: (d as { message?: string }).message });

      }

    };

    window.addEventListener("message", onMessage);

  });

}



function dataUrlToBlob(dataUrl: string): Blob {

  const [meta, b64] = dataUrl.split(",");

  const mime = /data:([^;]+);/.exec(meta || "")?.[1] || "application/octet-stream";

  const bin = atob(b64 || "");

  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Blob([bytes], { type: mime });

}



/** Client-side REF (same entropy as previous server helper). Email looks this up on orders/paid. */

function generateReferenceCode(): string {

  const bytes = new Uint8Array(6);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))

    .join("")

    .toUpperCase()

    .slice(0, 8);

}



function dieCutProductionKey(referenceCode: string): string {

  return `designs/die-cut/${referenceCode}/production.pdf`;

}

/**
 * Standalone same-origin upload to the AnyNest server, which writes the file to
 * the same R2 key the Shopify orders/paid email reads. Used only outside the
 * Shopify app-proxy shell (the shell path relays through the Shopify app).
 */
async function uploadDieCutToAnyNest(
  blob: Blob,
  objectKey: string,
  contentType: string,
): Promise<{ productionUrl: string | null; key: string | null }> {
  const form = new FormData();
  const filename = objectKey.split("/").pop() || "production.pdf";
  form.append("file", new File([blob], filename, { type: contentType }));
  form.append("objectKey", objectKey);
  form.append("contentType", contentType);
  const res = await fetch("/api/die-cut/upload", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  const json = JSON.parse(text) as { productionUrl?: string; key?: string };
  return {
    productionUrl: json.productionUrl || null,
    key: json.key || objectKey,
  };
}

/**
 * "Custom Size / Custom Quantity" on the standalone store. A preset variant such
 * as "2x2 / 300" would show those preset options on the cart line instead of the
 * customer's real size and quantity, and would charge its own catalog price.
 */
const STANDALONE_FALLBACK_VARIANT_ID = String(
  (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_DIE_CUT_FALLBACK_VARIANT_ID || "46288860905622",
).replace(/\D/g, "");

function isCustomVariant(variant: DieCutShopifyVariant): boolean {
  return /custom\s*(?:size|quantity)|custom.*custom/i.test(variant.title || "");
}

/**
 * Always use the store's "Custom Size / Custom Quantity" variant for the cart
 * line. The original preset matching lived in the separate
 * custom-sticker-designer Shopify app whose source is unavailable, so we don't
 * guess it. The real price is carried via _custom_price and applied by the
 * draft-order priceOverride, so the variant's catalog price never charges.
 */
export function matchDieCutVariant(
  variants: DieCutShopifyVariant[] | null | undefined,
  _widthInches: number,
  _heightInches: number,
  _quantity: number,
): DieCutShopifyVariant | null {
  if (!Array.isArray(variants) || !variants.length) return null;
  return variants.find(isCustomVariant) || null;
}

function resolveStandaloneStoreBase(input: DieCutCheckoutInput): string {
  const envBase = String(
    (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_DIE_CUT_STANDALONE_STORE_URL || "",
  ).trim();
  const pick = (u?: string | null): string => {
    if (!u) return "";
    try {
      return new URL(u).origin;
    } catch {
      /* not a full URL */
    }
    const s = String(u).trim().replace(/^https?:\/\//, "");
    return s.includes(".") ? `https://${s}` : "";
  };
  const resolved = pick(envBase) || pick(input.shopDomain);
  if (!resolved) {
    console.warn(
      "[die-cut checkout] VITE_DIE_CUT_STANDALONE_STORE_URL is not set; falling back to dtfmasters.com",
    );
    return "https://dtfmasters.com";
  }
  return resolved;
}

/**
 * Standalone (non-embed) add-to-cart. Builds a Shopify /cart/add permalink with
 * line-item properties and return_to=/cart, so the customer lands on the CART
 * (never straight to checkout), using the hard-coded custom variant fallback.
 */
function navigateStandaloneCartAdd(
  input: DieCutCheckoutInput,
  props: Record<string, string>,
  vidDigits: string,
): void {
  const base = resolveStandaloneStoreBase(input).replace(/\/+$/, "");
  const variant = vidDigits || STANDALONE_FALLBACK_VARIANT_ID;
  const url = new URL(`${base}/cart/add`);
  url.searchParams.set("id", variant);
  url.searchParams.set("quantity", "1");
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === "") continue;
    url.searchParams.set(`properties[${k}]`, String(v));
  }
  url.searchParams.set("return_to", "/cart");
  let target: Window = window;
  try {
    target = window.top || window;
  } catch {
    target = window;
  }
  try {
    target.location.href = url.toString();
  } catch {
    window.location.href = url.toString();
  }
}



/**

 * AnyNest-aligned checkout path:

 * 1) Generate REF in the builder

 * 2) Upload production PDF (+ preview) through Shopify shell R2 pipeline

 * 3) Add to Cart via dtf-builder-add-to-cart (continue shopping)

 * 4) Shell may create a Draft Order for custom sticker price

 * 5) After payment, Shopify app orders/paid webhook emails the R2 PDF

 */

export async function runDieCutCheckout(

  input: DieCutCheckoutInput,

): Promise<DieCutCheckoutResult> {

  const onProgress = input.onProgress || (() => undefined);

  const referenceCode = generateReferenceCode();

  const objectKey = dieCutProductionKey(referenceCode);



  const pdfBlob = dataUrlToBlob(

    input.pdfBase64.startsWith("data:")

      ? input.pdfBase64

      : `data:application/pdf;base64,${input.pdfBase64}`,

  );



  let productionUrl: string | null = null;

  let previewUrl: string | null = null;

  let productionKey: string | null = objectKey;



  const inShell = canUseShellRelay();

  const matchedVariant = matchDieCutVariant(
    input.variants,
    input.widthInches,
    input.heightInches,
    input.quantity,
  );

  // Standalone has no variant list to match against, so the custom-size variant
  // takes precedence over whatever variant the entry URL carried — that one is
  // whichever preset the product page happened to have selected.
  const vidDigits = String(
    matchedVariant?.id ||
      (inShell ? input.variantId : STANDALONE_FALLBACK_VARIANT_ID) ||
      input.variantId ||
      "",
  ).replace(/\D/g, "");

  const shop = String(input.shopDomain || "").trim();

  const previewKey = `designs/die-cut/${referenceCode}/preview.png`;

  onProgress("Uploading print file to Cloudflare R2...");

  if (inShell) {
    // Product-page / app-proxy shell path: relay upload through the Shopify app.
    try {
      const uploaded = await uploadProductionToR2(
        pdfBlob,
        `die-cut-${referenceCode}.pdf`,
        "",
        onProgress,
        {
          useShellRelay: true,
          productionFormat: "pdf",
          contentType: "application/pdf",
          objectKey,
        },
      );
      productionUrl = uploaded.productionUrl || productionUrl;
      productionKey = uploaded.key || objectKey;
      previewUrl = uploaded.cartPreviewUrl || uploaded.previewUrl || productionUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "R2 upload failed";
      throw new Error(`Failed to upload production PDF: ${msg}`);
    }

    if (input.previewDataUrl) {
      try {
        const previewBlob = dataUrlToBlob(input.previewDataUrl);
        const previewUploaded = await uploadProductionToR2(
          previewBlob,
          `die-cut-${referenceCode}-preview.png`,
          "",
          undefined,
          {
            useShellRelay: true,
            productionFormat: "png",
            contentType: "image/png",
            objectKey: previewKey,
          },
        );
        previewUrl =
          previewUploaded.cartPreviewUrl ||
          previewUploaded.productionUrl ||
          previewUrl;
      } catch {
        /* preview optional */
      }
    }
  } else {
    // Standalone path: upload same-origin to the AnyNest server, which writes
    // the identical R2 keys the orders/paid email reads.
    try {
      const uploaded = await uploadDieCutToAnyNest(pdfBlob, objectKey, "application/pdf");
      productionUrl = uploaded.productionUrl || productionUrl;
      productionKey = uploaded.key || objectKey;
      previewUrl = uploaded.productionUrl || previewUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "R2 upload failed";
      throw new Error(`Failed to upload production PDF: ${msg}`);
    }

    if (input.previewDataUrl) {
      try {
        const previewBlob = dataUrlToBlob(input.previewDataUrl);
        const previewUploaded = await uploadDieCutToAnyNest(
          previewBlob,
          previewKey,
          "image/png",
        );
        previewUrl = previewUploaded.productionUrl || previewUrl;
      } catch {
        /* preview optional */
      }
    }
  }

  const designUrl = productionUrl || "";

  const stickerProps = {

    Reference_Code: referenceCode,

    Sticker_Size: input.stickerSizeLabel,

    Quantity: String(input.quantity),

    Outline_Type: input.outlineType,

    Design_URL: designUrl,

    _Calculated_Price: input.displayTotal.toFixed(2),

    _Finish: input.finish,

    _Lamination: input.lamination,

    ...(input.imageName ? { Image_Name: input.imageName } : {}),

  };



  const designState = {

    schemaVersion: "die-cut-sticker-state.v1",

    builderPath: "/die-cut-stickers",

    builderType: "die-cut-stickers",

    referenceCode,

    stickerSize: input.stickerSizeLabel,

    widthInches: input.widthInches,

    heightInches: input.heightInches,

    quantity: input.quantity,

    outlineType: input.outlineType,

    finish: input.finish,

    lamination: input.lamination,

    displayTotal: input.displayTotal,

    productionUrl,

    previewUrl,

  };



  postMessageToParent({

    type: "stickerDesignReady",

    referenceCode,

    designUrl,

    stickerSize: input.stickerSizeLabel,

    widthInches: input.widthInches,

    heightInches: input.heightInches,

    quantity: input.quantity,

    outlineType: input.outlineType,

    finish: input.finish,

    lamination: input.lamination,

    imageName: input.imageName || null,

    displayTotal: input.displayTotal,

  });



  let usedShellAtc = false;

  if (inShell && vidDigits) {

    onProgress("Adding to cart...");

    const cartWait = waitForCartStatus();

    postMessageToParent({

      type: "dtf-builder-add-to-cart",

      builderType: "die-cut-stickers",

      useDraftOrder: true,

      checkoutMode: "cart",

      variantId: vidDigits,

      quantity: 1,

      gangsheetSize: input.stickerSizeLabel,

      shop: shop,

      filename: `die-cut-${referenceCode}.pdf`,

      productionExport: true,

      productionFormat: "pdf",

      builderUploaded: Boolean(productionUrl),

      productionUrl: productionUrl || undefined,

      productionKey: productionKey || undefined,

      cartPreviewUrl: previewUrl || productionUrl || undefined,

      customPrice: input.displayTotal,

      customPriceCents: Math.round(input.displayTotal * 100),

      stickerProperties: stickerProps,

      designState,

      dedupId: `diecut-${referenceCode}-${Date.now()}`,

      builderVersion: "die-cut-stickers",

    });

    await cartWait;

    usedShellAtc = true;

  } else if (!inShell) {

    // Standalone: add hard-coded custom variant to the store cart, land on /cart.

    onProgress("Redirecting to cart...");

    // The theme's cart line renders the design from _preview_url and links the
    // print file from _production_url. In the shell path the Shopify app writes
    // both; going straight to /cart/add means we have to send them ourselves.
    navigateStandaloneCartAdd(
      input,
      {
        ...stickerProps,
        ...(previewUrl ? { _preview_url: previewUrl } : {}),
        ...(productionUrl ? { _production_url: productionUrl } : {}),
      },
      vidDigits,
    );

  } else {

    throw new Error("Missing product variant — cannot add die-cut sticker to cart");

  }



  return {

    referenceCode,

    designUrl,

    productionUrl,

    previewUrl,

    usedShellAtc,

  };

}


