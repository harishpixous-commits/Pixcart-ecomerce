from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app import integrations
from app.config import settings
from app.core.errors import install_error_handlers
from app.core.observability import RequestContextMiddleware, configure_logging
from app.db import SessionLocal, engine
from app.integrations import runtime
from app.routers import (
    addresses,
    agents,
    admin,
    admin_accounts,
    admin_extras,
    growth,
    admin_payments,
    admin_prefs,
    admin_search,
    admin_shop_assistant,
    ai,
    assistant,
    auth,
    cart,
    catalog,
    checkout_admin,
    customer,
    delivery,
    delivery_admin,
    engagement,
    exports,
    orders,
    promotions,
    push,
    regional,
    seller_extras,
    seller_onboarding,
    seller_orders,
    seller_products,
    shop_assistant,
    staff,
    storefront,
    webhooks,
)
from app.routers import (
    integrations as integrations_router,
)

log = logging.getLogger("pixcart")

# Sentry starts as early as possible from the environment; a DSN saved in Admin → Integrations takes over
# at startup and whenever it changes. No request bodies, cookies or user details leave the server.
runtime.apply_sentry(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    settings.validate_for_production()
    try:
        runtime.apply_sentry(await integrations.get())
    except Exception:  # noqa: BLE001 — the database may still be migrating; the env DSN keeps working
        log.warning("could not read integration settings at startup", exc_info=True)
    scheduler = None
    if settings.run_jobs and settings.environment != "test":
        from app.jobs import start_scheduler

        scheduler = start_scheduler()
    log.info("%s API started (%s)", settings.app_name, settings.environment)
    yield
    if scheduler:
        scheduler.shutdown(wait=False)
    await engine.dispose()


app = FastAPI(
    title=f"{settings.app_name} Marketplace API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs" if settings.environment != "production" else None,
    openapi_url="/api/openapi.json" if settings.environment != "production" else None,
)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "X-Request-ID", "X-Chat-Key"],
)
install_error_handlers(app)

# customer before catalog: /api/catalog/delivery-estimate must not be captured by /api/catalog/products/{slug}
for r in (auth, addresses, storefront, customer, promotions, engagement, catalog, cart, orders, seller_onboarding, seller_products, seller_orders, seller_extras, admin, admin_extras, growth, admin_payments, admin_prefs, admin_search, admin_accounts, staff, integrations_router, exports, ai, assistant, shop_assistant, admin_shop_assistant, webhooks, delivery, delivery_admin, checkout_admin, push, regional, agents):
    app.include_router(r.router)
app.include_router(growth.me_router)


@app.get("/api/health")
async def health() -> dict:
    async with SessionLocal() as s:
        await s.execute(text("SELECT 1"))
    return {"status": "ok"}


if settings.storage_backend == "local":
    media = Path(settings.media_root)
    media.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=media), name="media")
