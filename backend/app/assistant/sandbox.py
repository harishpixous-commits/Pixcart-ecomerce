"""Sandbox answers when no language model is connected.

The decision layer picks the lookup and the real tools run, so the cards (figures, tables, charts,
downloads) are exact. Only the sentence around them is a fixed template. Every reply says it is sandbox
mode so nobody mistakes it for the full assistant.
"""
from __future__ import annotations

from typing import Any

from .decision import Decision, plan, rules
from .queries import inr

NOTE = "Sandbox mode: no AI model is connected, so I can only run common lookups. Connect a model in Admin → AI providers for full answers."

EXPORT_FOR = {"orders": "orders", "sales": "orders", "returns": "returns", "payouts": "payouts", "catalog": "products", "sellers": "sellers",
              "customers": "customers", "support": "tickets", "reports": "tcs"}


def choose(text: str, available: set[str], has_upload: bool) -> tuple[Decision, list[tuple[str, dict[str, Any]]]]:
    d = plan(rules(text, has_upload=has_upload), min_confidence=0.0, prefetch=True, available=available)
    calls = list(d.prefetch)
    low = text.lower()
    if d.intent == "file_analysis" and "file_overview" in available:
        calls = [("file_overview", {})]
    elif d.intent == "export_request" and "prepare_export" in available:
        fmt = "pdf" if "pdf" in low else ("csv" if "csv" in low else "xlsx")
        name = EXPORT_FOR.get(d.domains[0] if d.domains else "orders", "orders")
        calls = [("prepare_export", {"name": name, "format": fmt, **({"period": d.period} if d.period else {})})]
    elif not calls and d.intent == "data_question":
        top = d.domains[0] if d.domains else "overview"
        guess = {"orders": ("find_orders", {"period": d.period or "today"}), "customers": ("find_customers", {}), "catalog": ("find_products", {"status": "approved", "sort": "best_selling"}),
                 "sellers": ("find_sellers", {"period": d.period or "last_30_days"}), "marketing": ("coupons", {}), "settings": ("marketplace_settings", {}),
                 "sales": ("business_overview", {"period": d.period or "today"}), "overview": ("work_queue", {})}.get(top)
        if guess and guess[0] in available:
            calls = [guess]
        if top == "sales" and any(w in low for w in ("by day", "trend", "daily", "chart", "graph", "day wise", "day-wise")) and "sales_breakdown" in available:
            calls = [("sales_breakdown", {"by": "day", "period": d.period or "last_7_days"})]
    return d, calls[:2]


def reply(d: Decision, results: list[tuple[str, dict[str, Any] | Any]]) -> str:
    if d.intent == "small_talk":
        return f"Hello! Ask me about sales, orders, stock, returns, payouts or anything in the admin panel.\n\n({NOTE})"
    if not results:
        if d.intent == "change_request":
            return f"I can prepare changes like approvals, cancellations or coupons once an AI model is connected.\n\n({NOTE})"
        return f"I could not match that to a lookup. Try “sales today”, “orders this week”, “low stock”, “what needs attention”, or attach a file.\n\n({NOTE})"
    parts = []
    for name, data in results:
        if isinstance(data, dict) and data.get("error"):
            parts.append(str(data["error"]))
        elif name == "business_overview":
            c = data["current"]
            parts.append(f"{c['period']['label']}: **{inr(c['sales'])}** in sales from **{c['orders']}** orders "
                         f"(average {inr(c['average_order_value'])}, {c['cod_orders']} COD / {c['online_orders']} online).")
        elif name == "work_queue":
            waiting = [f"{v} {k.replace('_', ' ')}" for k, v in data.items() if v]
            parts.append("Waiting for attention: " + (", ".join(waiting) if waiting else "nothing right now."))
        elif name == "prepare_export":
            parts.append(f"Your {data.get('export', 'export')} ({str(data.get('format', '')).upper()}) is ready below. {data.get('filters', '')}")
        elif name == "stock_alerts":
            parts.append(f"{data['total']} live options have {data['threshold']} or fewer units; {data['out_of_stock']} of those shown are out of stock.")
        elif name == "order_details":
            parts.append(f"Order {data['number']} is {data['status']}, total {inr(data['grand_total'])}, paid by {data['payment_method'].upper()}.")
        elif name == "customer_profile":
            parts.append(f"{data['name'] or data['phone']}: {data['orders']} orders, net spend {inr(data['net_spend'])}, joined {data['joined']}.")
        elif name == "file_overview":
            parts.append(f"I read {data.get('filename')}: {data.get('rows', 0):,} rows. Column totals are below.")
        elif name == "sales_breakdown":
            parts.append(f"Sales by {data['by']} for {data['period']['label']} are in the chart below.")
        else:
            parts.append("Here is what I found.")
    return " ".join(parts) + f"\n\n({NOTE})"
