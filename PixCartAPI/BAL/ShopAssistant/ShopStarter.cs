namespace BAL.ShopAssistant;

/// <summary>Starter help articles, added once to an empty knowledge base (reference: shop_assistant/starter.py).
/// {placeholders} are filled from live settings when shown. Staff edit, hide or delete them afterwards.</summary>
public static class ShopStarter
{
    public const int StarterVersion = 2;
    public const string SeededKey = "shop_assistant_kb_seeded";

    /// <summary>Starter articles added later reach knowledge bases seeded earlier, once.</summary>
    public static readonly Dictionary<int, string[]> NewInVersion = new() { [2] = ["Fees on your bill"] };

    /// <summary>(topic, title, link, body, keywords in English, Tanglish, Tamil and Hindi)</summary>
    public static readonly (string Topic, string Title, string Link, string Body, string[] Keywords)[] Starter =
    [
        ("orders", "Track your order", "/orders",
         "Open **My orders** and choose the order. Each package ships separately from its seller, so one order can arrive in parts. " +
         "Once a package ships you see the courier, tracking number and a tracking link there. " +
         "Expected delivery is shown for every package.",
         ["track", "tracking", "where is my order", "order status", "not received", "enga", "eppo varum", "varala", "எங்கே", "ஆர்டர்", "कहाँ", "ऑर्डर कब"]),
        ("delivery", "Delivery time and charges", "/pages/shipping-policy",
         "Sellers ship from their own warehouses. Delivery usually takes {transit_same_city} day(s) in the same city, up to " +
         "{transit_same_state} days within the state and up to {transit_national} days elsewhere in India. The delivery fee is " +
         "{shipping_fee} per seller, and delivery is free when a seller's items in your order reach {free_delivery_amount}. " +
         "The product page shows the delivery date for your PIN code.",
         ["delivery charge", "shipping", "how many days", "delivery time", "free delivery", "pincode", "eththanai naal", "டெலிவரி", "डिलीवरी"]),
        ("payments", "Cash on delivery", "",
         "{cod_text}",
         ["cod", "cash on delivery", "pay on delivery", "cash", "panam", "காசு", "नकद"]),
        ("payments", "Fees on your bill", "",
         "{fees_text}",
         ["fee", "fees", "extra charge", "charges", "handling fee", "platform fee", "small cart", "late night", "night fee", "rain fee",
          "bad weather", "surge", "why charged", "kattanam", "extra panam", "கட்டணம்", "शुल्क", "चार्ज"]),
        ("payments", "Payment failed or money deducted", "",
         "If money left your account but the order still says payment pending, wait 30 minutes: the bank's confirmation usually " +
         "arrives on its own and the order is placed. If the payment is not confirmed, your bank reverses the amount within " +
         "5 to 7 working days. If it has not come back after that, raise a request with the order number and we will check it.",
         ["payment failed", "money deducted", "amount debited", "paid but", "transaction failed", "upi failed", "panam pochu", "பணம்", "पैसे कट"]),
        ("orders", "Cancel an order", "/orders",
         "You can cancel a package until it ships: open **My orders**, choose the order and press **Cancel this package**, or ask me " +
         "to do it. Online payments are refunded automatically to the original payment method within 5 to 7 working days. " +
         "Once a package has shipped it cannot be cancelled; you can return it after delivery if it is returnable.",
         ["cancel", "cancel order", "don't want", "venaam", "cancel pannanum", "ரத்து", "रद्द"]),
        ("returns", "Return a product", "/pages/returns-policy",
         "Every product page shows its return window, which starts on the delivery day. While it is open, open the order and choose " +
         "**Return items**, pick the items, the reason and (for cash on delivery) the UPI ID for your refund. The seller arranges the " +
         "pickup. Once the seller receives the item, the refund is issued and a credit note is added to your order.",
         ["return", "replace", "replacement", "exchange", "send back", "return pannanum", "திருப்பி", "वापस", "रिटर्न"]),
        ("returns", "When will I get my refund?", "",
         "Online payments: refunds go back to the original method and usually show within 5 to 7 working days of being issued " +
         "(UPI is often faster). Cash on delivery: the refund is sent to the UPI ID you gave with the return. The order page shows " +
         "each refund and its status.",
         ["refund", "refund status", "money back", "refund varala", "eppo refund", "பணம் திரும்ப", "रिफंड", "पैसा वापस"]),
        ("returns", "Damaged, defective or wrong item", "",
         "Sorry about that. If the return window is open, start a return from the order and choose **Item arrived damaged**, " +
         "**Item does not work** or **Received a different item**. If the window has closed or the item is not returnable, raise a " +
         "request with the order number and photos, and our team will help.",
         ["damaged", "broken", "defective", "not working", "wrong item", "different item", "fake", "udanjirukku", "சேதம்", "टूटा", "खराब"]),
        ("account", "Sign in and one-time codes (OTP)", "/login",
         "We sign you in with your mobile number and a 6-digit code sent by SMS; there is no password. If the code does not arrive, " +
         "check the number, wait 30 seconds and press **Resend code**. A code works for 5 minutes and only the latest code is valid.",
         ["otp", "login", "sign in", "code not received", "can't login", "password", "உள்நுழை", "लॉगिन"]),
        ("account", "Change address or phone number", "/account",
         "Saved addresses are in **My account**. The address of an order that is already placed cannot be changed; if it has not " +
         "shipped yet, cancel it and order again with the right address.",
         ["address", "change address", "wrong address", "phone number", "mobile number", "முகவரி", "पता"]),
        ("offers", "Coupons and offers", "",
         "Available coupons are listed at checkout; one coupon can be used per order and its conditions (minimum amount, first " +
         "order) are shown with it. Deals on products are shown on the home page and in search with **Sort by discount**.",
         ["coupon", "offer", "discount", "promo code", "deal", "sale", "கூப்பன்", "ऑफर"]),
        ("orders", "Invoice and GST bill", "/orders",
         "A tax invoice is issued by the seller when your package ships. Download it from the order page (**Invoice**). Returns get a " +
         "credit note on the same page.",
         ["invoice", "bill", "gst bill", "receipt", "பில்", "बिल"]),
        ("selling", "Sell on {brand}", "/sell",
         "Anyone with a GSTIN can sell on {brand}: sign in with your mobile, add your business, PAN and bank details, and list your " +
         "products once your account is approved. Start from **Become a seller**.",
         ["sell", "seller", "vendor", "become a seller", "list my products", "vikka", "விற்க", "बेचना"]),
        ("account", "Grievance officer", "/help/grievance",
         "{grievance_text}",
         ["grievance", "complaint", "escalate", "consumer", "legal", "புகார்", "शिकायत"]),
        ("account", "Your data and deleting your account", "/account",
         "In **My account** you can download your data, change marketing consent or delete your account. Orders already placed are " +
         "kept as long as tax law requires.",
         ["delete account", "privacy", "my data", "unsubscribe", "remove account"]),
        ("other", "Contact customer support", "/support",
         "Ask me first: I can check your orders, returns and refunds. If you still need a person, I can open a support request for " +
         "you; the team acknowledges within 48 hours and you can follow it under **Support**.",
         ["contact", "customer care", "human", "agent", "talk to someone", "call", "phone number", "support", "help"]),
    ];
}
