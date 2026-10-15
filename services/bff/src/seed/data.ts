/**
 * Static catalogue for the development seed.
 *
 * Everything here is real-shaped demo data for the four portals (admin, vendor,
 * customer, operations). Amounts are integer paise; DECIMAL(12,2) columns receive
 * formatted strings only at the insert boundary in seed.ts. Every state string
 * matches a CHECK constraint vocabulary from infra/db/migrations.
 */

/* ------------------------------------------------------------------ *
 * Catalogue tree — 4 roots + 8…10 leaves (2 levels, 12 categories).
 * ------------------------------------------------------------------ */

export interface CategoryDef {
  slug: string;
  name: string;
  schema: Record<string, unknown>;
}

const LEAF_SCHEMAS: Record<string, Record<string, unknown>> = {
  phones: {
    attributes: [
      { name: 'colour', type: 'enum', options: ['Black', 'Silver', 'Blue', 'Green'], required: true },
      { name: 'storageGb', type: 'int', required: false },
      { name: 'warrantyMonths', type: 'int', required: true },
    ],
  },
  audio: {
    attributes: [
      { name: 'colour', type: 'enum', options: ['Black', 'White', 'Navy'], required: true },
      { name: 'anc', type: 'bool', required: false },
      { name: 'warrantyMonths', type: 'int', required: true },
    ],
  },
  computing: {
    attributes: [
      { name: 'colour', type: 'enum', options: ['Space Grey', 'Silver', 'Black'], required: true },
      { name: 'warrantyMonths', type: 'int', required: true },
    ],
  },
  'fashion-men': {
    attributes: [
      { name: 'size', type: 'enum', options: ['S', 'M', 'L', 'XL'], required: true },
      { name: 'colour', type: 'enum', options: ['Navy', 'White', 'Olive', 'Black'], required: true },
      { name: 'fabric', type: 'text', required: false },
    ],
  },
  'fashion-women': {
    attributes: [
      { name: 'size', type: 'enum', options: ['XS', 'S', 'M', 'L'], required: true },
      { name: 'colour', type: 'enum', options: ['Rose', 'Ivory', 'Teal', 'Black'], required: true },
      { name: 'fabric', type: 'text', required: false },
    ],
  },
  'fashion-shoes': {
    attributes: [
      { name: 'size', type: 'enum', options: ['UK7', 'UK8', 'UK9', 'UK10'], required: true },
      { name: 'colour', type: 'enum', options: ['Black', 'White', 'Tan', 'Navy'], required: true },
    ],
  },
  'home-cookware': {
    attributes: [
      { name: 'diameterCm', type: 'int', required: false },
      { name: 'material', type: 'text', required: true },
      { name: 'inductionReady', type: 'bool', required: true },
    ],
  },
  'home-decor': {
    attributes: [
      { name: 'colour', type: 'enum', options: ['Warm White', 'Walnut', 'Natural'], required: true },
      { name: 'room', type: 'text', required: false },
    ],
  },
  'beauty-skincare': {
    attributes: [
      { name: 'skinType', type: 'enum', options: ['ALL', 'OILY', 'DRY', 'COMBINATION'], required: true },
      { name: 'volumeMl', type: 'int', required: true },
    ],
  },
  'beauty-personal-care': {
    attributes: [
      { name: 'batteryRuntimeMin', type: 'int', required: false },
      { name: 'warrantyMonths', type: 'int', required: true },
    ],
  },
};

const EMPTY_SCHEMA: Record<string, unknown> = { attributes: [] };

export interface RootDef extends CategoryDef {
  children: CategoryDef[];
}

export const categoryTree: RootDef[] = [
  {
    slug: 'electronics',
    name: 'Electronics',
    schema: EMPTY_SCHEMA,
    children: [
      { slug: 'phones', name: 'Smartphones & Accessories', schema: LEAF_SCHEMAS['phones']! },
      { slug: 'audio', name: 'Audio', schema: LEAF_SCHEMAS['audio']! },
      { slug: 'computing', name: 'Computing & Peripherals', schema: LEAF_SCHEMAS['computing']! },
    ],
  },
  {
    slug: 'fashion',
    name: 'Fashion',
    schema: EMPTY_SCHEMA,
    children: [
      { slug: 'fashion-men', name: 'Menswear', schema: LEAF_SCHEMAS['fashion-men']! },
      { slug: 'fashion-women', name: 'Womenswear', schema: LEAF_SCHEMAS['fashion-women']! },
      { slug: 'fashion-shoes', name: 'Footwear', schema: LEAF_SCHEMAS['fashion-shoes']! },
    ],
  },
  {
    slug: 'home-kitchen',
    name: 'Home & Kitchen',
    schema: EMPTY_SCHEMA,
    children: [
      { slug: 'home-cookware', name: 'Cookware & Kitchen', schema: LEAF_SCHEMAS['home-cookware']! },
      { slug: 'home-decor', name: 'Home Decor', schema: LEAF_SCHEMAS['home-decor']! },
    ],
  },
  {
    slug: 'beauty-health',
    name: 'Beauty & Health',
    schema: EMPTY_SCHEMA,
    children: [
      { slug: 'beauty-skincare', name: 'Skincare', schema: LEAF_SCHEMAS['beauty-skincare']! },
      { slug: 'beauty-personal-care', name: 'Personal Care', schema: LEAF_SCHEMAS['beauty-personal-care']! },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Brands and products — 4 brands, 40 products (4 per leaf category).
 * ------------------------------------------------------------------ */

export const brands = [
  { name: 'Zenith', slug: 'zenith' },
  { name: 'Aarav', slug: 'aarav' },
  { name: 'Nordic Line', slug: 'nordic-line' },
  { name: 'VoltEdge', slug: 'voltedge' },
];

export interface ProductDef {
  leaf: string;
  title: string;
  /** Index into `brands`. */
  brand: number;
  hsn: string;
  mrpPaise: number;
}

export const products: ProductDef[] = [
  { leaf: 'phones', title: 'Zenith Aurora X2 5G 128GB Smartphone', brand: 0, hsn: '85171200', mrpPaise: 1499900 },
  { leaf: 'phones', title: 'Zenith Aurora Lite 5G 64GB Smartphone', brand: 0, hsn: '85171200', mrpPaise: 999900 },
  { leaf: 'phones', title: 'VoltEdge PowerBank 20000mAh 65W', brand: 3, hsn: '85076000', mrpPaise: 249900 },
  { leaf: 'phones', title: 'VoltEdge 33W Turbo USB-C Charger', brand: 3, hsn: '85044000', mrpPaise: 129900 },
  { leaf: 'audio', title: 'Zenith SonicPods Pro ANC Earbuds', brand: 0, hsn: '85183000', mrpPaise: 699900 },
  { leaf: 'audio', title: 'VoltEdge BoomX Bluetooth Speaker', brand: 3, hsn: '85182200', mrpPaise: 349900 },
  { leaf: 'audio', title: 'Nordic Line Fjord Over-Ear Headphones', brand: 2, hsn: '85183000', mrpPaise: 499900 },
  { leaf: 'audio', title: 'Zenith SonicPods Lite Earbuds', brand: 0, hsn: '85183000', mrpPaise: 249900 },
  { leaf: 'computing', title: 'Zenith NovaBook 14 Laptop 16GB/512GB', brand: 0, hsn: '84713000', mrpPaise: 6499900 },
  { leaf: 'computing', title: 'VoltEdge MechKeys 75 Keyboard', brand: 3, hsn: '84716000', mrpPaise: 549900 },
  { leaf: 'computing', title: 'Nordic Line GlareFree 27-inch Monitor', brand: 2, hsn: '85285200', mrpPaise: 2199900 },
  { leaf: 'computing', title: 'Aarav SwiftGlide Wireless Mouse', brand: 1, hsn: '84716000', mrpPaise: 149900 },
  { leaf: 'fashion-men', title: 'Aarav Everyday Oxford Shirt', brand: 1, hsn: '62052000', mrpPaise: 129900 },
  { leaf: 'fashion-men', title: 'Nordic Line Merino Crew Sweater', brand: 2, hsn: '61102000', mrpPaise: 399900 },
  { leaf: 'fashion-men', title: 'Aarav Straight Fit Denim Jeans', brand: 1, hsn: '62034200', mrpPaise: 199900 },
  { leaf: 'fashion-men', title: 'Zenith TrackZip Running Jacket', brand: 0, hsn: '62019300', mrpPaise: 249900 },
  { leaf: 'fashion-women', title: 'Aarav Floral Anarkali Kurta', brand: 1, hsn: '62044400', mrpPaise: 179900 },
  { leaf: 'fashion-women', title: 'Nordic Line SoftKnit Cardigan', brand: 2, hsn: '61102000', mrpPaise: 279900 },
  { leaf: 'fashion-women', title: 'Aarav High-Rise Palazzo Pants', brand: 1, hsn: '62046600', mrpPaise: 129900 },
  { leaf: 'fashion-women', title: 'Zenith AeroFlex Yoga Set', brand: 0, hsn: '62046300', mrpPaise: 219900 },
  { leaf: 'fashion-shoes', title: 'Zenith StridePro Running Shoes', brand: 0, hsn: '64041100', mrpPaise: 349900 },
  { leaf: 'fashion-shoes', title: 'Aarav Kolhapuri Leather Sandals', brand: 1, hsn: '64031900', mrpPaise: 99900 },
  { leaf: 'fashion-shoes', title: 'Nordic Line Urban Chelsea Boots', brand: 2, hsn: '64039900', mrpPaise: 549900 },
  { leaf: 'fashion-shoes', title: 'VoltEdge CourtSide Sneakers', brand: 3, hsn: '64041100', mrpPaise: 279900 },
  { leaf: 'home-cookware', title: 'Nordic Line Granite Nonstick Frypan 26cm', brand: 2, hsn: '76151000', mrpPaise: 219900 },
  { leaf: 'home-cookware', title: 'Aarav Induction Base Kadai 24cm', brand: 1, hsn: '73239400', mrpPaise: 159900 },
  { leaf: 'home-cookware', title: 'VoltEdge SmartKettle 1.7L', brand: 3, hsn: '85166000', mrpPaise: 299900 },
  { leaf: 'home-cookware', title: 'Aarav Steel Lunch Box 3-Tier', brand: 1, hsn: '73239300', mrpPaise: 89900 },
  { leaf: 'home-decor', title: 'Zenith GlowHue Smart LED Strip 5m', brand: 0, hsn: '94054000', mrpPaise: 179900 },
  { leaf: 'home-decor', title: 'Nordic Line Oak Wall Clock', brand: 2, hsn: '91031000', mrpPaise: 249900 },
  { leaf: 'home-decor', title: 'Aarav Handwoven Jute Rug 5x7', brand: 1, hsn: '57022000', mrpPaise: 349900 },
  { leaf: 'home-decor', title: 'Zenith Aura Diffuser 300ml', brand: 0, hsn: '85165000', mrpPaise: 199900 },
  { leaf: 'beauty-skincare', title: 'Aarav Vitamin C Face Serum 30ml', brand: 1, hsn: '33049900', mrpPaise: 69900 },
  { leaf: 'beauty-skincare', title: 'Zenith Hydrating Sunscreen SPF50 100ml', brand: 0, hsn: '33049900', mrpPaise: 89900 },
  { leaf: 'beauty-skincare', title: 'Aarav Rose Clay Face Mask 100g', brand: 1, hsn: '33049900', mrpPaise: 54900 },
  { leaf: 'beauty-skincare', title: 'Nordic Line Niacinamide Toner 200ml', brand: 2, hsn: '33049900', mrpPaise: 79900 },
  { leaf: 'beauty-personal-care', title: 'VoltEdge Sonic Toothbrush Pro', brand: 3, hsn: '85098000', mrpPaise: 299900 },
  { leaf: 'beauty-personal-care', title: 'Nordic Line Hair Dryer 1800W', brand: 2, hsn: '85163200', mrpPaise: 349900 },
  { leaf: 'beauty-personal-care', title: 'VoltEdge Beard Trimmer X5', brand: 3, hsn: '85101000', mrpPaise: 199900 },
  { leaf: 'beauty-personal-care', title: 'Aarav Shea Body Lotion 400ml', brand: 1, hsn: '33049900', mrpPaise: 44900 },
];

/** Two display colours per product, used for the two variants of each listing. */
export const colourPairs: ReadonlyArray<readonly [string, string]> = [
  ['Obsidian', 'Pearl'],
  ['Navy', 'Ivory'],
  ['Forest', 'Sand'],
  ['Burgundy', 'Slate'],
  ['Charcoal', 'Sky'],
  ['Oxblood', 'Cream'],
  ['Teal', 'Ash'],
  ['Indigo', 'Fog'],
  ['Graphite', 'Rose'],
  ['Olive', 'Bone'],
];

/* ------------------------------------------------------------------ *
 * Vendors — 4 approved stores, one warehouse each.
 * ------------------------------------------------------------------ */

export interface VendorDef {
  key: string;
  legalName: string;
  displayName: string;
  skuCode: string;
  gstin: string;
  pan: string;
  email: string;
  mobile: string;
  storeSlug: string;
  logoUrl: string;
  ratingAvg: string;
  ratingCount: number;
  onTimePct: number;
  settings: Record<string, unknown>;
  location: { name: string; pincode: string; kind: string; city: string; state: string };
}

export const vendors: VendorDef[] = [
  {
    key: 'urban-cart',
    legalName: 'Urban Cart Retail Private Limited',
    displayName: 'Urban Cart',
    skuCode: 'URB',
    gstin: '29AABCU9603R1Z5',
    pan: 'AABCU9603R',
    email: 'ops@urbancart.example.in',
    mobile: '9845010001',
    storeSlug: 'urban-cart',
    logoUrl: '/img/vendors/urban-cart.svg',
    ratingAvg: '4.52',
    ratingCount: 1840,
    onTimePct: 96,
    settings: { payoutCycleDays: 7, autoAcceptOrders: true, codEnabled: true, supportHours: '09:00-18:00' },
    location: { name: 'Bengaluru Warehouse', pincode: '560001', kind: 'WAREHOUSE', city: 'Bengaluru', state: 'Karnataka' },
  },
  {
    key: 'nova-bazaar',
    legalName: 'Nova Bazaar Traders Private Limited',
    displayName: 'Nova Bazaar',
    skuCode: 'NOV',
    gstin: '07AAFCN2222K1Z9',
    pan: 'AAFCN2222K',
    email: 'ops@novabazaar.example.in',
    mobile: '9810020002',
    storeSlug: 'nova-bazaar',
    logoUrl: '/img/vendors/nova-bazaar.svg',
    ratingAvg: '4.31',
    ratingCount: 1205,
    onTimePct: 93,
    settings: { payoutCycleDays: 10, autoAcceptOrders: false, codEnabled: true, supportHours: '10:00-19:00' },
    location: { name: 'Delhi Warehouse', pincode: '110001', kind: 'WAREHOUSE', city: 'New Delhi', state: 'Delhi' },
  },
  {
    key: 'eco-essentials',
    legalName: 'Eco Essentials LLP',
    displayName: 'Eco Essentials',
    skuCode: 'ECO',
    gstin: '27AACCE5555P1Z2',
    pan: 'AACCE5555P',
    email: 'ops@ecoessentials.example.in',
    mobile: '9820030003',
    storeSlug: 'eco-essentials',
    logoUrl: '/img/vendors/eco-essentials.svg',
    ratingAvg: '4.67',
    ratingCount: 980,
    onTimePct: 98,
    settings: { payoutCycleDays: 7, autoAcceptOrders: true, codEnabled: false, supportHours: '09:30-18:30' },
    location: { name: 'Mumbai Warehouse', pincode: '400001', kind: 'WAREHOUSE', city: 'Mumbai', state: 'Maharashtra' },
  },
  {
    key: 'tech-harbor',
    legalName: 'Tech Harbor Systems Private Limited',
    displayName: 'Tech Harbor',
    skuCode: 'TEC',
    gstin: '36AAGCH8888L1Z1',
    pan: 'AAGCH8888L',
    email: 'ops@techharbor.example.in',
    mobile: '9866040004',
    storeSlug: 'tech-harbor',
    logoUrl: '/img/vendors/tech-harbor.svg',
    ratingAvg: '4.12',
    ratingCount: 760,
    onTimePct: 89,
    settings: { payoutCycleDays: 14, autoAcceptOrders: false, codEnabled: true, supportHours: '11:00-20:00' },
    location: { name: 'Hyderabad Warehouse', pincode: '500001', kind: 'WAREHOUSE', city: 'Hyderabad', state: 'Telangana' },
  },
];

/* ------------------------------------------------------------------ *
 * Staff (admin portal roles) and customers.
 * ------------------------------------------------------------------ */

export const staff = [
  { key: 'admin', email: 'priya.desai@pixcart.example.in', name: 'Priya Desai', role: 'ADMIN' },
  { key: 'finance', email: 'arnav.rao@pixcart.example.in', name: 'Arnav Rao', role: 'FINANCE' },
  { key: 'support', email: 'meera.joshi@pixcart.example.in', name: 'Meera Joshi', role: 'SUPPORT' },
  { key: 'marketing', email: 'kabir.sen@pixcart.example.in', name: 'Kabir Sen', role: 'MARKETING' },
  { key: 'warehouse', email: 'deepa.verma@pixcart.example.in', name: 'Deepa Verma', role: 'WAREHOUSE' },
];

export const customers = [
  { key: 'ananya', name: 'Ananya Sharma', email: 'ananya.sharma@example.in', mobile: '9810012345', lang: 'en', kycTier: 2 },
  { key: 'rohit', name: 'Rohit Mehta', email: 'rohit.mehta@example.in', mobile: '9810012346', lang: 'en', kycTier: 1 },
  { key: 'fatima', name: 'Fatima Khan', email: 'fatima.khan@example.in', mobile: '9810012347', lang: 'hi', kycTier: 2 },
  { key: 'vikram', name: 'Vikram Singh', email: 'vikram.singh@example.in', mobile: '9810012348', lang: 'en', kycTier: 0 },
  { key: 'priya-n', name: 'Priya Nair', email: 'priya.nair@example.in', mobile: '9810012349', lang: 'en', kycTier: 1 },
  { key: 'arjun', name: 'Arjun Iyer', email: 'arjun.iyer@example.in', mobile: '9810012350', lang: 'hi', kycTier: 0 },
];

export interface AddressDef {
  customer: number;
  label: 'HOME' | 'WORK' | 'OTHER';
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

export const addresses: AddressDef[] = [
  { customer: 0, label: 'HOME', line1: '14 Lavelle Road, Ashok Nagar', line2: null, landmark: 'near Cubbon Park gate', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', isDefault: true },
  { customer: 0, label: 'WORK', line1: '5th Floor, Prestige Tower, MG Road', line2: 'Block C', landmark: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560003', isDefault: false },
  { customer: 1, label: 'HOME', line1: 'A-42, Green Park Extension', line2: null, landmark: 'opposite metro pillar 12', city: 'New Delhi', state: 'Delhi', pincode: '110001', isDefault: true },
  { customer: 1, label: 'OTHER', line1: 'Sector 62, Tower B, Noida', line2: 'Flat 1204', landmark: null, city: 'Noida', state: 'Uttar Pradesh', pincode: '201301', isDefault: false },
  { customer: 2, label: 'HOME', line1: '8-3-19, Banjara Hills Road No. 5', line2: null, landmark: 'near Peddamma Temple', city: 'Hyderabad', state: 'Telangana', pincode: '500001', isDefault: true },
  { customer: 3, label: 'HOME', line1: '221 Linking Road, Bandra West', line2: 'A-wing 702', landmark: null, city: 'Mumbai', state: 'Maharashtra', pincode: '400001', isDefault: true },
  { customer: 3, label: 'WORK', line1: 'One BKC, Unit 1801', line2: null, landmark: 'Bandra Kurla Complex', city: 'Mumbai', state: 'Maharashtra', pincode: '400051', isDefault: false },
  { customer: 4, label: 'HOME', line1: '91 North Main Road, Koregaon Park', line2: null, landmark: 'next to lane 6', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  { customer: 5, label: 'HOME', line1: '33 Kamaraj Salai, Adyar', line2: null, landmark: 'near Adyar signal', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', isDefault: true },
  { customer: 5, label: 'OTHER', line1: '17 Race Course Road', line2: 'Flat 5B', landmark: null, city: 'Coimbatore', state: 'Tamil Nadu', pincode: '641001', isDefault: false },
];

/* ------------------------------------------------------------------ *
 * Orders — 10 orders between 2026-07-12 and 2026-10-09 (inside the
 * ord_order partition range), with sub-order states from the V004
 * vocabulary and payments in varied states.
 *
 * listingIndex: 0–39 are the primary listing of product N; 40–47 are the
 * second listing (different vendor) of products 0,5,10,15,20,25,30,35.
 * Vendor of primary listing N = N % 4; of secondary listing 40+k = (5k+2) % 4.
 * ------------------------------------------------------------------ */

export interface OrderPlan {
  key: string;
  customer: number;
  placedAt: string;
  lines: { listing: number; qty: number }[];
  shippingPaise: number;
  /** Flat discount in paise (takes precedence when set). */
  discountPaise?: number;
  /** Percentage discount in basis points of item total. */
  discountBps?: number;
  promoAllocation: Record<string, number>;
  status: string;
  payment: { method: 'UPI' | 'CARD' | 'NB' | 'WALLET' | 'COD'; status: 'INITIATED' | 'AUTHORISED' | 'CAPTURED' | 'FAILED' | 'EXPIRED' };
  /** vendorIndex → sub-order state (V004 vocabulary). */
  subStates: [number, string][];
}

export const orderPlan: OrderPlan[] = [
  {
    key: 'PC1001', customer: 0, placedAt: '2026-07-12 11:05:00.000',
    lines: [{ listing: 0, qty: 1 }, { listing: 10, qty: 1 }],
    shippingPaise: 0, discountPaise: 10000, promoAllocation: { SAVE100: 10000 },
    status: 'DELIVERED', payment: { method: 'UPI', status: 'CAPTURED' },
    subStates: [[0, 'DELIVERED'], [2, 'CLOSED']],
  },
  {
    key: 'PC1002', customer: 1, placedAt: '2026-07-28 18:40:00.000',
    lines: [{ listing: 4, qty: 2 }],
    shippingPaise: 4900, promoAllocation: {},
    status: 'DELIVERED', payment: { method: 'WALLET', status: 'CAPTURED' },
    subStates: [[0, 'DELIVERED']],
  },
  {
    key: 'PC1003', customer: 2, placedAt: '2026-08-05 09:15:00.000',
    lines: [{ listing: 9, qty: 1 }],
    shippingPaise: 0, promoAllocation: {},
    status: 'CANCELLED', payment: { method: 'UPI', status: 'FAILED' },
    subStates: [[1, 'CANCELLED']],
  },
  {
    key: 'PC1004', customer: 3, placedAt: '2026-08-19 21:00:00.000',
    lines: [{ listing: 13, qty: 1 }, { listing: 22, qty: 1 }],
    shippingPaise: 0, discountBps: 1500, promoAllocation: { FESTIVE15: 0 },
    status: 'PARTIALLY_SHIPPED', payment: { method: 'NB', status: 'CAPTURED' },
    subStates: [[1, 'DELIVERED'], [2, 'SHIPPED']],
  },
  {
    key: 'PC1005', customer: 4, placedAt: '2026-09-02 14:20:00.000',
    lines: [{ listing: 17, qty: 1 }],
    shippingPaise: 4900, promoAllocation: {},
    status: 'SHIPPED', payment: { method: 'CARD', status: 'CAPTURED' },
    subStates: [[1, 'OUT_FOR_DELIVERY']],
  },
  {
    key: 'PC1006', customer: 5, placedAt: '2026-09-15 08:55:00.000',
    lines: [{ listing: 25, qty: 3 }],
    shippingPaise: 0, discountBps: 1000, promoAllocation: { WELCOME10: 0 },
    status: 'NDR', payment: { method: 'CARD', status: 'CAPTURED' },
    subStates: [[1, 'NDR']],
  },
  {
    key: 'PC1007', customer: 0, placedAt: '2026-09-27 19:30:00.000',
    lines: [{ listing: 30, qty: 1 }, { listing: 34, qty: 1 }, { listing: 36, qty: 1 }],
    shippingPaise: 0, discountPaise: 5000, promoAllocation: { WALLET_SPEND: 5000 },
    status: 'PARTIALLY_REFUNDED', payment: { method: 'UPI', status: 'CAPTURED' },
    subStates: [[2, 'REFUNDED'], [0, 'DELIVERED']],
  },
  {
    key: 'PC1008', customer: 1, placedAt: '2026-10-02 12:10:00.000',
    lines: [{ listing: 39, qty: 1 }],
    shippingPaise: 4900, promoAllocation: {},
    status: 'CONFIRMED', payment: { method: 'CARD', status: 'CAPTURED' },
    subStates: [[3, 'PACKED']],
  },
  {
    key: 'PC1009', customer: 2, placedAt: '2026-10-06 16:45:00.000',
    lines: [{ listing: 41, qty: 2 }],
    shippingPaise: 0, promoAllocation: {},
    status: 'CONFIRMED', payment: { method: 'COD', status: 'AUTHORISED' },
    subStates: [[3, 'ACCEPTED']],
  },
  {
    key: 'PC1010', customer: 3, placedAt: '2026-10-09 22:05:00.000',
    lines: [{ listing: 44, qty: 1 }, { listing: 12, qty: 1 }],
    shippingPaise: 0, promoAllocation: {},
    status: 'CONFIRMED', payment: { method: 'UPI', status: 'INITIATED' },
    subStates: [[2, 'CONFIRMED'], [0, 'CONFIRMED']],
  },
];

/* ------------------------------------------------------------------ *
 * RMA plan — 8 requests in different states, each tied to a real
 * (order, listing) line. `refundFull` settles the full line amount.
 * ------------------------------------------------------------------ */

export interface RmaPlan {
  key: string;
  orderKey: string;
  listing: number;
  state: string;
  reasonCode: string;
  reasonText: string;
  refundFull: boolean;
  refundMethod: 'ORIGINAL' | 'WALLET' | null;
}

export const rmaPlan: RmaPlan[] = [
  { key: 'RMA01', orderKey: 'PC1007', listing: 30, state: 'REFUNDED', reasonCode: 'DAMAGED', reasonText: 'Frypan arrived with a chipped rim.', refundFull: true, refundMethod: 'ORIGINAL' },
  { key: 'RMA02', orderKey: 'PC1004', listing: 13, state: 'REQUESTED', reasonCode: 'SIZE_ISSUE', reasonText: 'Sweater too tight; want size L.', refundFull: false, refundMethod: null },
  { key: 'RMA03', orderKey: 'PC1004', listing: 22, state: 'APPROVED', reasonCode: 'NOT_AS_DESCRIBED', reasonText: 'Colour is darker than the photos.', refundFull: false, refundMethod: null },
  { key: 'RMA04', orderKey: 'PC1001', listing: 0, state: 'PICKED_UP', reasonCode: 'QUALITY_ISSUE', reasonText: 'Screen has a dead pixel cluster.', refundFull: false, refundMethod: null },
  { key: 'RMA05', orderKey: 'PC1001', listing: 10, state: 'QC_PASSED', reasonCode: 'MISSING_PARTS', reasonText: 'Laptop box did not include the charger.', refundFull: false, refundMethod: null },
  { key: 'RMA06', orderKey: 'PC1002', listing: 4, state: 'REFUND_INITIATED', reasonCode: 'WRONG_ITEM', reasonText: 'Received SonicPods Lite instead of Pro.', refundFull: true, refundMethod: 'WALLET' },
  { key: 'RMA07', orderKey: 'PC1005', listing: 17, state: 'REJECTED', reasonCode: 'CHANGED_MIND', reasonText: 'Did not like the knit after trying it on.', refundFull: false, refundMethod: null },
  { key: 'RMA08', orderKey: 'PC1006', listing: 25, state: 'CLOSED', reasonCode: 'LATE_DELIVERY', reasonText: 'Shoes arrived 9 days late, gift was for a birthday.', refundFull: true, refundMethod: 'ORIGINAL' },
];

/** State path (from_state → to_state chain) written to rma_event per RMA state. */
export const rmaStatePaths: Record<string, string[]> = {
  REQUESTED: ['REQUESTED'],
  APPROVED: ['REQUESTED', 'APPROVED'],
  PICKED_UP: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP'],
  QC_PASSED: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'QC_PASSED'],
  REFUND_INITIATED: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'QC_PASSED', 'REFUND_INITIATED'],
  REFUNDED: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'QC_PASSED', 'REFUND_INITIATED', 'REFUNDED'],
  REJECTED: ['REQUESTED', 'REJECTED'],
  CLOSED: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'QC_PASSED', 'REFUND_INITIATED', 'REFUNDED', 'CLOSED'],
};

/* ------------------------------------------------------------------ *
 * Wallet funding: each customer gets a welcome CASH top-up; Rohit's is
 * large enough that the WALLET-captured order PC1002 (full-amount wallet
 * spend) plus the RMA06 wallet refund keep his balance non-negative.
 * ------------------------------------------------------------------ */

export const walletCashPaise: Record<number, number> = {
  0: 50000,
  1: 400000,
  2: 50000,
  3: 50000,
  4: 50000,
  5: 50000,
};

export const WALLET_PROMO_PAISE = 10000;
export const WALLET_PROMO_EXPIRES = '2026-12-15 00:00:00.000';

/* ------------------------------------------------------------------ *
 * Coupons — 10 across the engine's states.
 * ------------------------------------------------------------------ */

export interface CouponDef {
  code: string;
  description: string;
  kind: 'PERCENT' | 'FLAT';
  valueBps: number;
  valuePaise: number;
  maxRedemptions: number;
  usedCount: number;
  minCartPaise: number;
  perUserLimit: number;
  startsAt: string;
  endsAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXHAUSTED' | 'EXPIRED';
}

export const coupons: CouponDef[] = [
  { code: 'SAVE100', description: 'Flat Rs.100 off on orders above Rs.199', kind: 'FLAT', valueBps: 0, valuePaise: 10000, maxRedemptions: 5000, usedCount: 214, minCartPaise: 19900, perUserLimit: 1, startsAt: '2026-09-01 00:00:00.000', endsAt: '2026-11-30 23:59:59.000', status: 'ACTIVE' },
  { code: 'FESTIVE15', description: '15% off across Fashion during the festive week', kind: 'PERCENT', valueBps: 1500, valuePaise: 0, maxRedemptions: 3000, usedCount: 812, minCartPaise: 99900, perUserLimit: 2, startsAt: '2026-08-15 00:00:00.000', endsAt: '2026-10-31 23:59:59.000', status: 'ACTIVE' },
  { code: 'WELCOME10', description: '10% off your first order, up to Rs.500', kind: 'PERCENT', valueBps: 1000, valuePaise: 0, maxRedemptions: 10000, usedCount: 1530, minCartPaise: 49900, perUserLimit: 1, startsAt: '2026-06-01 00:00:00.000', endsAt: '2026-12-31 23:59:59.000', status: 'ACTIVE' },
  { code: 'FLASH200', description: 'Flat Rs.200 off during the weekend flash sale', kind: 'FLAT', valueBps: 0, valuePaise: 20000, maxRedemptions: 1000, usedCount: 0, minCartPaise: 99900, perUserLimit: 1, startsAt: '2026-10-16 00:00:00.000', endsAt: '2026-10-18 23:59:59.000', status: 'PAUSED' },
  { code: 'NEWUSER25', description: '25% off for newly registered customers', kind: 'PERCENT', valueBps: 2500, valuePaise: 0, maxRedemptions: 2000, usedCount: 96, minCartPaise: 0, perUserLimit: 1, startsAt: '2026-09-10 00:00:00.000', endsAt: '2026-12-10 23:59:59.000', status: 'ACTIVE' },
  { code: 'MONSOON5', description: '5% off during the monsoon refresh sale', kind: 'PERCENT', valueBps: 500, valuePaise: 0, maxRedemptions: 4000, usedCount: 2210, minCartPaise: 49900, perUserLimit: 2, startsAt: '2026-07-01 00:00:00.000', endsAt: '2026-09-01 23:59:59.000', status: 'EXPIRED' },
  { code: 'BIGSAVE30', description: '30% Independence Day special, fully redeemed', kind: 'PERCENT', valueBps: 3000, valuePaise: 0, maxRedemptions: 500, usedCount: 500, minCartPaise: 149900, perUserLimit: 1, startsAt: '2026-08-05 00:00:00.000', endsAt: '2026-08-20 23:59:59.000', status: 'EXHAUSTED' },
  { code: 'DIWALI500', description: 'Flat Rs.500 off for the Diwali campaign (draft)', kind: 'FLAT', valueBps: 0, valuePaise: 50000, maxRedemptions: 5000, usedCount: 0, minCartPaise: 399900, perUserLimit: 1, startsAt: '2026-11-01 00:00:00.000', endsAt: '2026-11-20 23:59:59.000', status: 'DRAFT' },
  { code: 'FREESHIP', description: 'Flat Rs.49 shipping credit on any order', kind: 'FLAT', valueBps: 0, valuePaise: 4900, maxRedemptions: 8000, usedCount: 640, minCartPaise: 0, perUserLimit: 3, startsAt: '2026-08-01 00:00:00.000', endsAt: '2026-12-31 23:59:59.000', status: 'ACTIVE' },
  { code: 'GLOW20', description: '20% off Skincare & Personal Care', kind: 'PERCENT', valueBps: 2000, valuePaise: 0, maxRedemptions: 2500, usedCount: 388, minCartPaise: 39900, perUserLimit: 2, startsAt: '2026-09-20 00:00:00.000', endsAt: '2026-11-20 23:59:59.000', status: 'ACTIVE' },
];

/* ------------------------------------------------------------------ *
 * CMS — pages, banners and blocks for the customer portal.
 * ------------------------------------------------------------------ */

export interface CmsDef {
  slug: string;
  kind: 'PAGE' | 'BANNER' | 'BLOCK';
  title: string;
  body: string | null;
  mediaUrl: string | null;
  linkUrl: string | null;
  locale: string;
  status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'UNPUBLISHED';
  publishAt: string | null;
  unpublishAt: string | null;
  createdByRole: string;
}

export const cmsEntries: CmsDef[] = [
  { slug: 'about-us', kind: 'PAGE', title: 'About PixCart', body: 'PixCart is a multi-vendor marketplace connecting independent sellers with customers across India. Every vendor is KYC-verified and every order is backed by a 7-day return window.', mediaUrl: null, linkUrl: null, locale: 'en', status: 'PUBLISHED', publishAt: '2026-07-01 09:00:00.000', unpublishAt: null, createdByRole: 'ADMIN' },
  { slug: 'terms', kind: 'PAGE', title: 'Terms of Service', body: 'These terms govern your use of the PixCart marketplace, including orders, returns, refunds and vendor responsibilities. Marketplace facilitator norms apply to all GST-invoiced sales.', mediaUrl: null, linkUrl: null, locale: 'en', status: 'PUBLISHED', publishAt: '2026-07-01 09:00:00.000', unpublishAt: null, createdByRole: 'ADMIN' },
  { slug: 'privacy', kind: 'PAGE', title: 'Privacy Policy', body: 'We process personal data only for order fulfilment, support and — with your consent — marketing. You can withdraw consent any time from Account → Privacy.', mediaUrl: null, linkUrl: null, locale: 'en', status: 'PUBLISHED', publishAt: '2026-07-01 09:00:00.000', unpublishAt: null, createdByRole: 'ADMIN' },
  { slug: 'faq', kind: 'PAGE', title: 'Frequently Asked Questions', body: 'How long do returns take? How is my wallet refunded? Which payment methods are supported? Answers to the most common customer questions live here.', mediaUrl: null, linkUrl: null, locale: 'en', status: 'PUBLISHED', publishAt: '2026-07-15 10:00:00.000', unpublishAt: null, createdByRole: 'SUPPORT' },
  { slug: 'homepage-hero', kind: 'BANNER', title: 'Great prices from verified sellers', body: 'Shop electronics, fashion and home essentials from KYC-verified vendors with doorstep returns.', mediaUrl: '/img/banners/hero-festive.svg', linkUrl: '/catalogue', locale: 'en', status: 'PUBLISHED', publishAt: '2026-09-15 00:00:00.000', unpublishAt: null, createdByRole: 'MARKETING' },
  { slug: 'diwali-sale-2026', kind: 'BANNER', title: 'Diwali Sale — up to 40% off', body: 'Festive deals across every category. Stack eligible coupons at checkout for extra savings.', mediaUrl: '/img/banners/diwali-2026.svg', linkUrl: '/campaigns/diwali', locale: 'en', status: 'SCHEDULED', publishAt: '2026-11-01 00:00:00.000', unpublishAt: '2026-11-20 23:59:59.000', createdByRole: 'MARKETING' },
  { slug: 'trust-badges', kind: 'BLOCK', title: 'Why shop on PixCart', body: 'KYC-verified sellers · Secure payments · 7-day returns · Wallet refunds within 24 hours.', mediaUrl: null, linkUrl: null, locale: 'en', status: 'PUBLISHED', publishAt: '2026-07-01 09:00:00.000', unpublishAt: null, createdByRole: 'ADMIN' },
  { slug: 'app-download', kind: 'BLOCK', title: 'Get the PixCart app', body: 'Track orders, chat with sellers and unlock app-only deals. Download for Android and iOS.', mediaUrl: '/img/blocks/app-download.svg', linkUrl: '/apps', locale: 'en', status: 'DRAFT', publishAt: null, unpublishAt: null, createdByRole: 'MARKETING' },
];

/* ------------------------------------------------------------------ *
 * Notification inbox — 10 templates cycled twice for 20 messages.
 * ------------------------------------------------------------------ */

export interface NotifTemplate {
  category: 'ORDER' | 'PAYMENT' | 'PROMO' | 'SYSTEM' | 'RETURN';
  severity: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  title: string;
  body: string;
  linkPrefix: string | null;
}

export const notifTemplates: NotifTemplate[] = [
  { category: 'ORDER', severity: 'SUCCESS', title: 'Order {ref} confirmed', body: 'Thanks! Your order is confirmed and the seller has been notified.', linkPrefix: '/orders/' },
  { category: 'ORDER', severity: 'INFO', title: 'Order {ref} shipped', body: 'Your package is on its way. Track the courier for live updates.', linkPrefix: '/orders/' },
  { category: 'ORDER', severity: 'INFO', title: 'Order {ref} out for delivery', body: 'Your package will arrive today. Keep your phone handy for the delivery call.', linkPrefix: '/orders/' },
  { category: 'PAYMENT', severity: 'SUCCESS', title: 'Payment captured for {ref}', body: 'We received your payment. The invoice is available in order details.', linkPrefix: '/orders/' },
  { category: 'PAYMENT', severity: 'WARNING', title: 'Payment pending for {ref}', body: 'We could not capture your payment yet. Retry from order details within 30 minutes.', linkPrefix: '/orders/' },
  { category: 'RETURN', severity: 'INFO', title: 'Return picked up for {ref}', body: 'Your return has been picked up. Refund starts after quality check.', linkPrefix: '/orders/' },
  { category: 'RETURN', severity: 'SUCCESS', title: 'Refund credited for {ref}', body: 'Your refund has been initiated to the original payment method.', linkPrefix: '/orders/' },
  { category: 'PROMO', severity: 'INFO', title: 'Weekend deals are live', body: 'Up to 40% off across electronics and fashion. Offer ends Sunday midnight.', linkPrefix: '/campaigns/weekend' },
  { category: 'SYSTEM', severity: 'INFO', title: 'Password changed', body: 'Your account password was changed. Contact support if this was not you.', linkPrefix: '/account/security' },
  { category: 'SYSTEM', severity: 'INFO', title: 'Wallet top-up received', body: 'A wallet credit has been added to your account. Check Wallet for details.', linkPrefix: '/account/wallet' },
];
