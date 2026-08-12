import { normalizeShopifyPrice } from "./shopify-price";

type AjaxVariant = {
  id: number;
  title?: string;
  price?: string | number;
  option1?: string;
  option2?: string;
  option3?: string;
};

type AjaxProduct = {
  id?: number;
  options?: Array<{ name?: string }>;
  variants?: AjaxVariant[];
};

function storefrontAjaxBaseUrl(shop?: string | null): string {
  const s = String(shop || "").trim();
  if (s) {
    return `https://${s.replace(/^https?:\/\//i, "").split("/")[0]}`;
  }
  const custom = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim();
  if (custom) {
    return `https://${custom.replace(/^https?:\/\//i, "").split("/")[0]}`;
  }
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || "").trim();
  if (!domain) return "";
  return `https://${domain.replace(/^https?:\/\//i, "").split("/")[0]}`;
}

function mapProductToVariantList(product: AjaxProduct, selectedVariantDigits: string) {
  const nodes = product?.variants;
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const optionNames = (product.options || []).map((o) => o?.name || "Option");
  return {
    selectedVariantId: `gid://shopify/ProductVariant/${selectedVariantDigits}`,
    variants: nodes.map((v) => {
      const selectedOptions: Array<{ name: string; value: string }> = [];
      if (v.option1) {
        selectedOptions.push({ name: optionNames[0] || "Option", value: String(v.option1) });
      }
      if (v.option2) {
        selectedOptions.push({ name: optionNames[1] || "Option", value: String(v.option2) });
      }
      if (v.option3) {
        selectedOptions.push({ name: optionNames[2] || "Option", value: String(v.option3) });
      }
      return {
        id: `gid://shopify/ProductVariant/${v.id}`,
        title: String(v.title ?? ""),
        price: normalizeShopifyPrice(v.price),
        selectedOptions,
      };
    }),
  };
}

async function fetchProductByHandle(base: string, handle: string): Promise<AjaxProduct | null> {
  const h = String(handle || "").trim().replace(/^\/+|\/+$/g, "");
  if (!h) return null;
  const res = await fetch(`${base}/products/${encodeURIComponent(h)}.js`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    console.error("[storefront-variant-config] products/handle.js", res.status, h);
    return null;
  }
  return (await res.json()) as AjaxProduct;
}

async function fetchProductById(base: string, productId: string): Promise<AjaxProduct | null> {
  const id = String(productId || "").replace(/\D/g, "");
  if (!id) return null;
  const res = await fetch(`${base}/products.json?ids=${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    console.error("[storefront-variant-config] products.json", res.status, id);
    return null;
  }
  const json = (await res.json()) as { products?: AjaxProduct[] };
  return json?.products?.[0] ?? null;
}

export async function fetchStorefrontVariantList(
  variantIdRaw: string,
  opts: { productId?: string | null; productHandle?: string | null; shop?: string | null } = {},
) {
  const digits = String(variantIdRaw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const base = storefrontAjaxBaseUrl(opts.shop);
  if (!base) return null;

  const productHandle = String(opts.productHandle || "").trim();
  const productId = String(opts.productId || "").trim();

  if (productHandle) {
    const product = await fetchProductByHandle(base, productHandle);
    if (product) return mapProductToVariantList(product, digits);
  }

  if (productId) {
    const product = await fetchProductById(base, productId);
    if (product) return mapProductToVariantList(product, digits);
  }

  const variantRes = await fetch(`${base}/variants/${digits}.js`, {
    headers: { Accept: "application/json" },
  });
  if (!variantRes.ok) {
    console.error("[storefront-variant-config] variant.js", variantRes.status, digits);
    return null;
  }
  const variant = (await variantRes.json()) as {
    product_id?: number;
    featured_image?: { product_id?: number };
  };
  const legacyProductId = variant?.product_id ?? variant?.featured_image?.product_id ?? null;
  if (!legacyProductId) {
    console.error(
      "[storefront-variant-config] variant.js missing product_id — pass product_id or product_handle from theme",
      digits,
    );
    return null;
  }

  const product = await fetchProductById(base, String(legacyProductId));
  if (!product) return null;
  return mapProductToVariantList(product, digits);
}
