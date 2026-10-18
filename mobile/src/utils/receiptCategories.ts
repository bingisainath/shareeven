// src/utils/receiptCategories.ts
// Item categories on scanned receipts (same keys as backend/app/services/receipt_ai/learning.py).

export const RECEIPT_CATEGORIES: { key: string; label: string }[] = [
  { key: 'produce', label: 'Fruit & veg' }, { key: 'dairy', label: 'Dairy' }, { key: 'bakery', label: 'Bakery' },
  { key: 'meat', label: 'Meat' }, { key: 'fish', label: 'Fish' }, { key: 'frozen', label: 'Frozen' },
  { key: 'pantry', label: 'Pantry' }, { key: 'snacks', label: 'Snacks' }, { key: 'drinks', label: 'Drinks' },
  { key: 'alcohol', label: 'Alcohol' }, { key: 'household', label: 'Household & cleaning' },
  { key: 'personal_care', label: 'Personal care' }, { key: 'health', label: 'Health' }, { key: 'baby', label: 'Baby' },
  { key: 'pet', label: 'Pet' }, { key: 'bags', label: 'Bags' }, { key: 'other', label: 'Other' },
];

export const categoryLabel = (key: string | null | undefined) =>
  RECEIPT_CATEGORIES.find((c) => c.key === key)?.label || (key ? key[0].toUpperCase() + key.slice(1) : '');
