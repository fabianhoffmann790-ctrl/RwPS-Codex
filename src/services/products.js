const STORAGE_KEY = 'rwps.products.v1';

const DEFAULT_PRODUCTS = [
  { id: crypto.randomUUID(), name: 'Produkt A', articleNumber: 'ART-001', manufacturingDurationMin: 45 },
  { id: crypto.randomUUID(), name: 'Produkt B', articleNumber: 'ART-002', manufacturingDurationMin: 60 },
];

function normalizeArticleNumber(value) {
  return value.trim().toUpperCase();
}

function loadProducts() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PRODUCTS;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PRODUCTS;

    return parsed
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => ({
        id: entry.id || crypto.randomUUID(),
        name: entry.name.trim(),
        articleNumber: normalizeArticleNumber(String(entry.articleNumber ?? '')),
        manufacturingDurationMin: Number(entry.manufacturingDurationMin),
      }))
      .filter(
        (entry) =>
          entry.name.length > 0 &&
          entry.articleNumber.length > 0 &&
          Number.isInteger(entry.manufacturingDurationMin) &&
          entry.manufacturingDurationMin > 0
      );
  } catch {
    return DEFAULT_PRODUCTS;
  }
}

function persistProducts(products) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
}

function sortByName(products) {
  return [...products].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getProducts() {
  return sortByName(loadProducts());
}

export async function createProduct({ name, articleNumber, manufacturingDurationMin }) {
  const products = loadProducts();
  const normalizedName = name.trim();
  const normalizedArticleNumber = normalizeArticleNumber(articleNumber);

  if (products.some((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('Ein Produkt mit diesem Namen existiert bereits.');
  }

  if (products.some((entry) => entry.articleNumber === normalizedArticleNumber)) {
    throw new Error('Diese Artikelnummer ist bereits vergeben.');
  }

  const next = {
    id: crypto.randomUUID(),
    name: normalizedName,
    articleNumber: normalizedArticleNumber,
    manufacturingDurationMin,
  };

  const updated = [...products, next];
  persistProducts(updated);
  return next;
}

export async function updateProduct(id, { name, articleNumber, manufacturingDurationMin }) {
  const products = loadProducts();
  const normalizedName = name.trim();
  const normalizedArticleNumber = normalizeArticleNumber(articleNumber);

  if (
    products.some(
      (entry) => entry.id !== id && entry.name.toLowerCase() === normalizedName.toLowerCase()
    )
  ) {
    throw new Error('Ein Produkt mit diesem Namen existiert bereits.');
  }

  if (products.some((entry) => entry.id !== id && entry.articleNumber === normalizedArticleNumber)) {
    throw new Error('Diese Artikelnummer ist bereits vergeben.');
  }

  const updated = products.map((entry) =>
    entry.id === id
      ? { ...entry, name: normalizedName, articleNumber: normalizedArticleNumber, manufacturingDurationMin }
      : entry
  );

  persistProducts(updated);
  return updated.find((entry) => entry.id === id);
}

export async function deleteProduct(id) {
  const products = loadProducts();
  const updated = products.filter((entry) => entry.id !== id);
  persistProducts(updated);
}
