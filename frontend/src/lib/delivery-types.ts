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
