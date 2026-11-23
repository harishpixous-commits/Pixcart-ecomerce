from __future__ import annotations

from app.core.validators import gstin_check_char, validate_gstin
from app.services import sms
from tests.conftest import PDF, login_phone, make_seller, valid_gstin


async def test_otp_login_wrong_code_then_success_and_refresh_rotation(client):
    r = await client.post("/api/auth/otp/request", json={"phone": "+91 98765 43210"})
    assert r.status_code == 200
    code = sms.DEV_OUTBOX["9876543210"]

    # Resend too soon is refused.
    r = await client.post("/api/auth/otp/request", json={"phone": "9876543210"})
    assert r.status_code == 429

    wrong = "000000" if code != "000000" else "111111"
    r = await client.post("/api/auth/otp/verify", json={"phone": "9876543210", "code": wrong})
    assert r.status_code == 400 and r.json()["error"]["code"] == "otp_invalid"

    r = await client.post("/api/auth/otp/verify", json={"phone": "9876543210", "code": code, "name": "Anu"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_new"] is True and body["user"]["name"] == "Anu"
    old_cookie = client.cookies.get("pc_refresh")
    assert old_cookie

    # The code cannot be reused.
    r = await client.post("/api/auth/otp/verify", json={"phone": "9876543210", "code": code})
    assert r.status_code == 400

    # Refresh needs the CSRF header.
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 403
    r = await client.post("/api/auth/refresh", headers={"X-Requested-With": "pixcart"})
    assert r.status_code == 200
    new_cookie = client.cookies.get("pc_refresh")
    assert new_cookie and new_cookie != old_cookie

    # The same browser racing itself (a reload while the refresh was on its way) is not theft: renewed quietly.
    client.cookies.clear()
    client.cookies.set("pc_refresh", old_cookie, path="/api/auth")
    r = await client.post("/api/auth/refresh", headers={"X-Requested-With": "pixcart"})
    assert r.status_code == 200
    raced_cookie = r.cookies.get("pc_refresh")
    assert raced_cookie and raced_cookie not in (old_cookie, new_cookie)

    # Replaying a rotated token from another browser revokes every session of the user (theft detection).
    client.cookies.clear()
    client.cookies.set("pc_refresh", old_cookie, path="/api/auth")
    r = await client.post("/api/auth/refresh", headers={"X-Requested-With": "pixcart", "User-Agent": "Stolen/1.0"})
    assert r.status_code == 401
    for cookie in (new_cookie, raced_cookie):
        client.cookies.clear()
        client.cookies.set("pc_refresh", cookie, path="/api/auth")
        r = await client.post("/api/auth/refresh", headers={"X-Requested-With": "pixcart"})
        assert r.status_code == 401


async def test_otp_attempt_limit(client):
    await client.post("/api/auth/otp/request", json={"phone": "9000000001"})
    code = sms.DEV_OUTBOX["9000000001"]
    wrong = "999999" if code != "999999" else "888888"
    for _ in range(5):
        r = await client.post("/api/auth/otp/verify", json={"phone": "9000000001", "code": wrong})
        assert r.status_code == 400
    r = await client.post("/api/auth/otp/verify", json={"phone": "9000000001", "code": code})
    assert r.status_code == 429


async def test_invalid_phone_rejected(client):
    r = await client.post("/api/auth/otp/request", json={"phone": "12345"})
    assert r.status_code == 422
    assert "mobile" in r.json()["error"]["message"]


async def test_admin_password_login_and_rbac(client, admin):
    r = await client.post("/api/auth/login", json={"email": "admin@pixcart.in", "password": "wrong"})
    assert r.status_code == 401
    customer = await login_phone(client, "9111111111")
    r = await customer.get("/api/admin/dashboard")
    assert r.status_code == 403
    r = await admin.get("/api/admin/dashboard")
    assert r.status_code == 200
    r = await client.get("/api/admin/dashboard")
    assert r.status_code == 401


def test_gstin_checksum():
    g = valid_gstin("33", "ABCDE1234F")
    assert validate_gstin(g) == g
    bad = g[:-1] + ("A" if g[-1] != "A" else "B")
    try:
        validate_gstin(bad)
        raise AssertionError("bad checksum accepted")
    except ValueError:
        pass
    # Known public example: 27AAPFU0939F1ZV (Maharashtra)
    assert gstin_check_char("27AAPFU0939F1Z") == "V"


async def test_seller_onboarding_validation_and_review(client, admin):
    s = await login_phone(client, "9222222222", "Meena")
    r = await s.post("/api/seller/register", {"display_name": "Meena Fabrics"})
    assert r.status_code == 201
    seller_id = r.json()["id"]

    # Submitting early lists what is missing.
    r = await s.post("/api/seller/submit")
    assert r.status_code == 400 and "Pickup address" in r.json()["error"]["message"]

    base = {
        "display_name": "Meena Fabrics",
        "legal_name": "Meena Fabrics LLP",
        "business_type": "llp",
        "contact_email": "meena@example.com",
        "contact_phone": "9222222222",
    }
    r = await s.put("/api/seller/profile", {**base, "gstin": "33ABCDE1234F1Z0", "pan": "ABCDE1234F"})
    assert r.status_code == 422  # bad check digit
    r = await s.put("/api/seller/profile", {**base, "gstin": valid_gstin("33", "ABCDE1234F"), "pan": "ZZZZZ9999Z"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "pan_gstin_mismatch"
    r = await s.put("/api/seller/profile", {**base, "gstin": valid_gstin("33", "ABCDE1234F"), "pan": "ABCDE1234F"})
    assert r.status_code == 200
    assert r.json()["pan"] == "XXXXXX234F"

    r = await s.put("/api/seller/bank", {"holder_name": "Meena", "account_number": "123456789", "confirm_account_number": "123456780", "ifsc": "SBIN0001234"})
    assert r.status_code == 400
    r = await s.put("/api/seller/bank", {"holder_name": "Meena", "account_number": "123456789", "confirm_account_number": "123456789", "ifsc": "SBIN0001234"})
    assert r.status_code == 200 and r.json()["bank"]["account_number"] == "XXXX6789"

    # Pickup in a different state from the GSTIN is refused at submit.
    r = await s.put("/api/seller/pickup-address", {"line1": "1 Main Rd", "city": "Bengaluru", "state_code": "29", "pincode": "560001"})
    assert r.status_code == 200
    await s.put("/api/seller/grievance-officer", {"name": "Meena R", "email": "g@example.com", "phone": "9222222222"})
    r = await client.post("/api/seller/documents/pan_card", headers=s.h(), files={"file": ("x.exe", b"MZ\x90\x00", "application/pdf")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_document"
    for kind in ("pan_card", "gst_certificate", "cancelled_cheque"):
        r = await client.post(f"/api/seller/documents/{kind}", headers=s.h(), files={"file": ("d.pdf", PDF, "application/pdf")})
        assert r.status_code == 200
    r = await s.post("/api/seller/submit")
    assert r.status_code == 400 and r.json()["error"]["code"] == "gstin_state_mismatch"
    await s.put("/api/seller/pickup-address", {"line1": "1 Main Rd", "city": "Coimbatore", "state_code": "33", "pincode": "641001"})
    r = await s.post("/api/seller/submit")
    assert r.status_code == 200 and r.json()["status"] == "submitted"

    # Locked while under review.
    r = await s.put("/api/seller/bank", {"holder_name": "New Holder", "account_number": "999999999", "confirm_account_number": "999999999", "ifsc": "SBIN0001234"})
    assert r.status_code == 409

    # A seller cannot approve themselves.
    r = await s.post(f"/api/admin/sellers/{seller_id}/approve")
    assert r.status_code == 403

    # Admin sees full KYC (decrypted) and documents; sends back with a reason.
    r = await admin.get(f"/api/admin/sellers/{seller_id}")
    assert r.status_code == 200 and r.json()["pan"] == "ABCDE1234F" and r.json()["bank"]["account_number"] == "123456789"
    r = await admin.get(f"/api/admin/sellers/{seller_id}/documents/pan_card")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    r = await admin.post(f"/api/admin/sellers/{seller_id}/reject", {"reason": "Cheque image is not readable"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    r = await s.get("/api/seller/me")
    assert r.json()["rejection_reason"] == "Cheque image is not readable"
    r = await s.post("/api/seller/submit")
    assert r.status_code == 200
    r = await admin.post(f"/api/admin/sellers/{seller_id}/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved"

    # Another user cannot read this seller's documents.
    other = await login_phone(client, "9333333333")
    r = await other.get("/api/seller/documents/pan_card")
    assert r.status_code == 403


async def test_duplicate_gstin_refused(client, admin):
    await make_seller(client, admin, "9444444444", name="First Store", pan="AAAAA1111A")
    s = await login_phone(client, "9555555555")
    await s.post("/api/seller/register", {"display_name": "Copy Store"})
    r = await s.put(
        "/api/seller/profile",
        {
            "display_name": "Copy Store",
            "legal_name": "Copy",
            "business_type": "individual",
            "gstin": valid_gstin("33", "AAAAA1111A"),
            "pan": "AAAAA1111A",
            "contact_email": "c@example.com",
            "contact_phone": "9555555555",
        },
    )
    assert r.status_code == 409
