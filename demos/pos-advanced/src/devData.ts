/**
 * Dev fallback data used when running outside the dotuix viewer
 * (e.g. plain browser / Vite dev server without bridge mock).
 * In production the catalog comes from data.db via uix.data.find().
 */
import type { Category, Product, Staff, TaxRate } from './types';

export const DEV_CATEGORIES: Category[] = [
  { id: 'cat:drinks', name: 'Drinks', icon: '☕', color: '#e85d04', sort: 1 },
  { id: 'cat:food', name: 'Food', icon: '🍔', color: '#55aa77', sort: 2 },
  { id: 'cat:desserts', name: 'Desserts', icon: '🧁', color: '#e06bbb', sort: 3 },
  { id: 'cat:extras', name: 'Extras', icon: '🛍', color: '#5588ff', sort: 4 },
];

export const DEV_TAX_RATES: TaxRate[] = [
  { id: 'tax:std', name: 'Standard', rate: 10, isDefault: true },
  { id: 'tax:zero', name: 'Zero-rated', rate: 0, isDefault: false },
];

export const DEV_PRODUCTS: Product[] = [
  // Drinks
  {
    id: 'p:001',
    name: 'Espresso',
    sku: 'DRK-001',
    price: 12,
    categoryId: 'cat:drinks',
    inStock: true,
  },
  {
    id: 'p:002',
    name: 'Cappuccino',
    sku: 'DRK-002',
    price: 16,
    categoryId: 'cat:drinks',
    inStock: true,
  },
  {
    id: 'p:003',
    name: 'Latte',
    sku: 'DRK-003',
    price: 18,
    categoryId: 'cat:drinks',
    inStock: true,
  },
  {
    id: 'p:004',
    name: 'Cold Brew',
    sku: 'DRK-004',
    price: 20,
    categoryId: 'cat:drinks',
    inStock: true,
  },
  {
    id: 'p:005',
    name: 'Fresh Juice',
    sku: 'DRK-005',
    price: 22,
    categoryId: 'cat:drinks',
    inStock: true,
  },
  // Food
  {
    id: 'p:006',
    name: 'Club Sandwich',
    sku: 'FD-001',
    price: 45,
    categoryId: 'cat:food',
    inStock: true,
  },
  {
    id: 'p:007',
    name: 'Caesar Salad',
    sku: 'FD-002',
    price: 38,
    categoryId: 'cat:food',
    inStock: true,
  },
  {
    id: 'p:008',
    name: 'Beef Burger',
    sku: 'FD-003',
    price: 55,
    categoryId: 'cat:food',
    inStock: true,
  },
  {
    id: 'p:009',
    name: 'Margherita Pizza',
    sku: 'FD-004',
    price: 65,
    categoryId: 'cat:food',
    inStock: true,
  },
  {
    id: 'p:010',
    name: 'Chicken Wrap',
    sku: 'FD-005',
    price: 42,
    categoryId: 'cat:food',
    inStock: false,
  },
  // Desserts
  {
    id: 'p:011',
    name: 'Cheesecake Slice',
    sku: 'DST-001',
    price: 28,
    categoryId: 'cat:desserts',
    inStock: true,
  },
  {
    id: 'p:012',
    name: 'Chocolate Lava',
    sku: 'DST-002',
    price: 32,
    categoryId: 'cat:desserts',
    inStock: true,
  },
  {
    id: 'p:013',
    name: 'Crème Brûlée',
    sku: 'DST-003',
    price: 30,
    categoryId: 'cat:desserts',
    inStock: true,
  },
  {
    id: 'p:014',
    name: 'Ice Cream Bowl',
    sku: 'DST-004',
    price: 24,
    categoryId: 'cat:desserts',
    inStock: true,
  },
  // Extras
  {
    id: 'p:015',
    name: 'Carry Bag',
    sku: 'EXT-001',
    price: 2,
    categoryId: 'cat:extras',
    inStock: true,
  },
  {
    id: 'p:016',
    name: 'Gift Wrapping',
    sku: 'EXT-002',
    price: 15,
    categoryId: 'cat:extras',
    inStock: true,
  },
  {
    id: 'p:017',
    name: 'Extra Sauce',
    sku: 'EXT-003',
    price: 5,
    categoryId: 'cat:extras',
    inStock: true,
  },
  {
    id: 'p:018',
    name: 'Add-On Cheese',
    sku: 'EXT-004',
    price: 8,
    categoryId: 'cat:extras',
    inStock: true,
  },
  {
    id: 'p:019',
    name: 'Bottle Water',
    sku: 'EXT-005',
    price: 6,
    categoryId: 'cat:extras',
    inStock: true,
  },
  {
    id: 'p:020',
    name: 'Mixed Nuts',
    sku: 'EXT-006',
    price: 18,
    categoryId: 'cat:extras',
    inStock: true,
  },
];

export const DEV_STAFF: Staff[] = [
  { id: 'staff:1', name: 'Manager', pin: '1234', role: 'manager', color: '#c8a96e' },
  { id: 'staff:2', name: 'Cashier', pin: '5678', role: 'cashier', color: '#5588ff' },
  { id: 'staff:3', name: 'Supervisor', pin: '9999', role: 'supervisor', color: '#55aa77' },
];
