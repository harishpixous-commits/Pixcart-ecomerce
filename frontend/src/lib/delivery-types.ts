/* Types for the delivery partner app (/delivery) and the admin's delivery pages. Amounts are in paise. */

export type KycStatus = "draft" | "submitted" | "approved" | "rejected";
export type VehicleType = "bike" | "scooter" | "ev" | "cycle" | "auto" | "van";
export type IdProof = "aadhaar" | "pan" | "voter" | "passport";

export interface DeliveryOptions {
  enabled: boolean;
  registration_open: boolean;
  offer_seconds: number;
  proof_photo_required: boolean;
  delivery_otp_required: boolean;
  pickup_code_required: boolean;
  location_seconds: number;
  map_tiles: string;
  map_attribution: string;
  support_phone: string;
  support_whatsapp: string;
  android_apk_url: string;
  play_store_url: string;
  app_version: string;
  require_vehicle_doc: boolean;
  fee_mode: "fixed" | "distance";
  fee_fixed_paise: number;
  fee_base_paise: number;
  fee_per_km_paise: number;
  vehicles: Record<VehicleType, string>;
  id_proofs: Record<IdProof, string>;
  reject_reasons: Record<string, string>;
  fail_reasons: Record<string, string>;
  zones: { id: string; name: string; city: string }[];
}

export interface Partner {
  id: string;
  name: string;
  phone: string;
  photo: string;
  city: string;
  address: string;
  license_no: string;
  id_proof_type: IdProof | "";
  id_proof_label: string;
  id_proof_last4: string;
  vehicle_type: VehicleType;
  vehicle_label: string;
  vehicle_no: string;
  zone: { id: string; name: string; city: string } | null;
  is_online: boolean;
  is_active: boolean;
  kyc_status: KycStatus;
  kyc_label: string;
  kyc_note: string;
  approved_at: string | null;
  docs: { license: boolean; id_proof: boolean; vehicle_rc: boolean };
  bank: { holder: string; ifsc: string; account_last4: string; upi: string; set: boolean };
  rating_avg: number;
  rating_count: number;
  checklist: { key: string; label: string; done: boolean }[];
  can_submit: boolean;
  editable: boolean;
  location: { lat: number | null; lng: number | null; at: string | null };
  created_at: string | null;
  user_id?: string;
}

/* ---------------------------------------------------------------- trips */

export type TripStatus =
  | "offered" | "accepted" | "at_store" | "picked" | "on_the_way" | "reached" | "delivered"
  | "rejected" | "expired" | "cancelled" | "failed";

export const LIVE_STATUSES: TripStatus[] = ["offered", "accepted", "at_store", "picked", "on_the_way", "reached"];

/** One delivery request or trip (fleet.assignment_brief). */
export interface TripBrief {
  id: string;
  status: TripStatus;
  status_label: string;
  /** delivery; return = a package going back to the store; pickup = collecting a customer's return */
  kind: "delivery" | "return" | "pickup";
  mode: "manual" | "auto";
  assigned_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  at_store_at: string | null;
  picked_at: string | null;
  on_the_way_at: string | null;
  reached_at: string | null;
  delivered_at: string | null;
  status_at: string;
  reject_reason: string;
  fail_reason: string;
  cod_amount: number;
  cod_collected: number;
  cod_method: string;
  fee: number;
  tip: number;
  distance_km: number | null;
  rating: number | null;
  rating_comment: string;
  has_proof: boolean;
  return_id?: string | null;
}

export interface TripPlace {
  name: string;
  address: string;
  city: string;
  pincode: string;
  phone: string;
  lat: number | null;
  lng: number | null;
}

/** Everything about one trip (fleet.trip_view). The customer's name, phone and address are empty while it is an offer. */
export interface TripView extends TripBrief {
  order_number: string;
  order_id: string;
  sub_order_id: string;
  payment: "cod" | "online";
  pickup: TripPlace;
  drop: TripPlace & { instructions: string; no_bag: boolean };
  items: { title: string; variant: string; qty: number; image: string }[];
  fee_estimate: number;
  needs: { pickup_code: boolean; otp: boolean; photo: boolean };
  partner: { id: string; name: string; phone: string; photo: string; vehicle: string; vehicle_no: string; lat: number | null; lng: number | null; location_at: string | null };
  pickup_code?: string;
  /** a return pickup: the customer's return number */
  return_number?: string;
  seconds_left?: number;
  minutes_in_step?: number;
  stuck?: boolean;
  log?: { status: string; note: string; at: string; actor?: string; lat?: number | null; lng?: number | null }[];
}

export interface PartnerFeed {
  offers: TripView[];
  active: TripView[];
  is_online: boolean;
  /** false when the account is switched off or deliveries are paused: only trips in hand */
  taking_requests?: boolean;
  today: { trips: number; earned: number };
  cash_in_hand: number;
  cash_limit: number;
  offer_seconds: number;
  server_time: string;
}

export interface EarningsPeriod { trips: number; fees: number; tips: number; earned: number; cod_collected: number }

export interface PayoutRow {
  id: string;
  period_start: string;
  period_end: string;
  deliveries: number;
  amount: number;
  cod_deducted: number;
  net_amount: number;
  status: "pending" | "paid";
  paid_at: string | null;
  reference: string;
}

export interface PartnerEarnings {
  today: EarningsPeriod;
  week: EarningsPeriod;
  month: EarningsPeriod;
  total: EarningsPeriod;
  days: { date: string; trips: number; earned: number }[];
  cash_in_hand: number;
  cash_limit: number;
  unpaid: number;
  payouts: PayoutRow[];
  deposits: { amount: number; method: string; reference: string; at: string }[];
}

export type HistoryItem = TripBrief & { order_number: string; drop_area: string };

/* ---------------------------------------------------------------- admin */

export interface DeliveryOverview {
  partners: Record<string, number>;
  online: number;
  zones: number;
  fleet_mode: string;
  auto_assign: boolean;
  enabled: boolean;
  queue: number;
  offered: number;
  on_trip: number;
  delivered_today: number;
  failed_today: number;
  stuck: number;
  stuck_minutes: number;
}

export interface LivePartner {
  id: string;
  name: string;
  phone: string;
  photo: string;
  vehicle: string;
  vehicle_no: string;
  zone: { id: string; name: string; city: string } | null;
  online: boolean;
  online_since: string | null;
  online_minutes: number | null;
  lat: number | null;
  lng: number | null;
  location_age_seconds: number | null;
  location_state: "live" | "stale" | "unknown";
  load: number;
  max_active: number;
  state: "free" | "on_trip";
  trips: { id: string; order_number: string; status: TripStatus; status_label: string; stuck: boolean }[];
  today_trips: number;
  today_earned: number;
  cash_in_hand: number;
  cash_limit: number;
  rating_avg: number;
  rating_count: number;
}

export interface LiveData {
  partners: LivePartner[];
  trips: TripView[];
  zones: { id: string; name: string; city: string; lat: number | null; lng: number | null }[];
  summary: { online: number; free: number; on_trip: number; stuck: number; waiting: number; cash_in_hand: number };
  by_zone: { zone: string; online: number; free: number; on_trip: number }[];
  map_tiles: string;
  map_attribution: string;
  server_time: string;
}

export interface QueuePackage {
  sub_order_id: string;
  order_id: string;
  order_number: string;
  status: string;
  ready_since: string | null;
  pickup: TripPlace;
  drop: { name: string; city: string; pincode: string; lat: number | null; lng: number | null };
  zone: { id: string; name: string } | null;
  payment: "cod" | "online";
  cod_amount: number;
  pickup_code: string;
  tries: { status: TripStatus; reason: string; partner: string }[];
  /** the "Return pickups" tab: the return to collect */
  return_id?: string;
  return_number?: string;
  return_items?: string[];
  assignment?: TripBrief & { partner: string; partner_phone: string; seconds_left?: number | null };
}

export interface Candidate {
  id: string;
  name: string;
  phone: string;
  photo: string;
  vehicle: string;
  zone: string;
  online: boolean;
  distance_km: number | null;
  load: number;
  cash: number;
  location_fresh: boolean;
  ok: boolean;
  reasons: string[];
  rating_avg: number;
}
