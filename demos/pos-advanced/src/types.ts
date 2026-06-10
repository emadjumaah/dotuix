export interface Staff {
  id: string;
  name: string;
  pin: string;
  role: 'manager' | 'cashier' | 'supervisor';
  color: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort: number;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  categoryId: string;
  desc?: string;
  inStock: boolean;
}

export interface TaxRate {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
}

export interface CartItem {
  productId: string;
  name: string;
  sku: string;
  price: number;
  qty: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  sku: string;
  price: number;
  qty: number;
}

export interface Order {
  id: string;
  receiptNo: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  taxRateId: string;
  taxRateName: string;
  taxRatePct: number;
  staff: string;
  staffId: string;
  method: 'cash' | 'card' | 'split';
  status: 'complete' | 'refunded';
  createdAt: string;
}

export type Screen = 'catalog' | 'checkout' | 'orders' | 'reports' | 'settings';
