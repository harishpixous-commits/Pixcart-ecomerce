/* One-time demo setup on the clean demo database: delivery zone, fleet settings and an approved partner. */
const { deflateSync } = require("node:zlib");
const { apiAs } = require("./rec.cjs");

function png(size = 240, rgb = [11, 85, 99]) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const s = Buffer.alloc(4); s.writeUInt32BE(crc(body)); return Buffer.concat([l, body, s]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih.set([8, 2, 0, 0, 0], 8);
  const px = Buffer.alloc(size * 3); for (let i = 0; i < size; i++) px.set(rgb, i * 3);
  const row = Buffer.concat([Buffer.from([0]), px]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function approvedPartner(admin, zoneId, phone, name, vehicleNo) {
  const rider = await apiAs(phone, name);
  const r = await rider.post("/api/delivery/register", { name, city: "Bengaluru", address: "4 Hosur Road, Koramangala", vehicle_type: "scooter", vehicle_no: vehicleNo,
    license_no: "KA01 20190012345", id_proof_type: "aadhaar", id_proof_no: "234567890123", zone_id: zoneId });
  if (![200, 201, 409].includes(r.status())) console.log("register", r.status(), await r.text());
  for (const [kind, file] of [["photo", { name: "me.png", mimeType: "image/png", buffer: png() }], ["license", { name: "dl.pdf", mimeType: "application/pdf", buffer: PDF }],
    ["id_proof", { name: "id.pdf", mimeType: "application/pdf", buffer: PDF }]]) {
    const up = await rider.upload(`/api/delivery/me/docs/${kind}`, file);
    if (!up.ok()) console.log("doc", kind, up.status(), await up.text());
  }
  await rider.put("/api/delivery/me/bank", { holder: name, account_number: "123456789012", confirm_account_number: "123456789012", ifsc: "SBIN0001234" });
  await rider.post("/api/delivery/me/submit");
  const me = await rider.get("/api/delivery/me");
  const ok = await admin.post(`/api/admin/delivery/partners/${me.id}/kyc`, { action: "approve", zone_id: zoneId });
  console.log("partner", name, phone, ok.status());
  await rider.dispose();
}

(async () => {
  const admin = await apiAs("admin");
  const zones = await admin.get("/api/admin/delivery/zones");
  let zone = zones.find((z) => z.pincodes.includes("560034"));
  if (!zone) {
    const r = await admin.post("/api/admin/delivery/zones", { name: "Koramangala", city: "Bengaluru", pincodes: ["560095", "560034", "560047"], center_lat: 12.9352, center_lng: 77.6245 });
    zone = await r.json();
  }
  const s = await admin.put("/api/admin/delivery/settings", { enabled: true, fleet_mode: "zones", auto_assign: true });
  console.log("zone", zone.name, "settings", s.status());
  if (process.argv[2] !== "zone-only") await approvedPartner(admin, zone.id, "7300000001", "Arun Kumar", "KA 01 AB 1234");
  await admin.dispose();
})().catch((e) => { console.error(e); process.exit(1); });
