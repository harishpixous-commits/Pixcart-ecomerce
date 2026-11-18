"""The customer-facing shop assistant: chat and voice help on the storefront.

Isolation from the admin assistant is a design rule, not a convention:

- its own tables (``shop_chat_*``, ``shop_kb_articles``), settings key (``platform_settings['shop_assistant']``),
  prompts, tools and HTTP routes (``/api/shop-assistant``);
- it never imports ``app.assistant``, ``app.ai`` or any admin router (``tests/test_shop_assistant.py`` checks this);
- tools see only public catalogue data, the help knowledge base, whitelisted public settings, and the
  signed-in customer's own orders, returns, refunds and tickets. The customer is taken from the session,
  never from the model's arguments, and every record is re-checked for ownership;
- answers are built by whitelist serializers (``views.py``): commission, payouts, TCS/TDS, seller KYC and
  staff-only ticket notes have no path into a reply.

It shares only the model transport (``app.llm``: provider connections and keys), on its own route
``shop_assistant`` so a different model can be chosen for customers. Without a model it runs in guided mode:
the same tools, chosen by multilingual rules (``intents.py``).
"""
