namespace Model.Constants;

/// <summary>
/// Every notification event with its default text per channel (the reference version's notify.EVENTS). Admins can
/// change the text in Admin → Notifications (notification_templates); these are used until they do. {{name}} placeholders
/// are filled when the notification is created. Channels: inapp, email, sms, whatsapp, push (push uses the in-app text
/// unless a push template exists).
/// </summary>
public static class NotificationEvents
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, (string Subject, string Body)>> Events =
        new Dictionary<string, IReadOnlyDictionary<string, (string Subject, string Body)>>
        {
            ["order_placed"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Order placed", "Your order {{order_number}} for {{amount}} is placed."),
                ["email"] = ("Your {{brand}} order {{order_number}} is placed", "Hi {{name}},\n\nThank you for shopping on {{brand}}. Your order {{order_number}} for {{amount}} is placed. We will tell you when each package ships.\n\nTrack it here: {{link}}"),
                ["sms"] = ("", "Your {{brand}} order {{order_number}} for {{amount}} is placed."),
            },
            ["order_shipped"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Package shipped", "{{item}} has shipped with {{courier}}, tracking {{awb}}."),
                ["email"] = ("Your package from {{seller}} has shipped", "Hi {{name}},\n\n{{item}} has shipped with {{courier}} (tracking {{awb}}).\n\nTrack it here: {{link}}"),
                ["sms"] = ("", "Your {{brand}} package {{order_number}} has shipped with {{courier}}, AWB {{awb}}."),
            },
            ["order_delivered"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivered", "{{item}} was delivered. Tell others what you think by writing a review."),
                ["email"] = ("Delivered: {{item}}", "Hi {{name}},\n\nYour package was delivered. If something is wrong, you can request a return until {{return_by}}.\n\n{{link}}"),
            },
            ["abandoned_cart"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("You left something in your cart", "{{item}}{{more}} is still waiting in your cart ({{amount}}).{{offer}}"),
                ["email"] = ("{{item}} is still in your {{brand}} cart", "Hi {{name}},\n\n{{item}}{{more}} is still waiting in your cart ({{amount}}).{{offer}}\n\nFinish your order: {{link}}"),
            },
            ["order_delay"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Your package is running late", "Package {{order_number}} was due on {{expected}} and has not arrived yet. It is still on its way. You can follow it in your orders."),
                ["email"] = ("Your package {{order_number}} is running late", "Hi {{name}},\n\nPackage {{order_number}} was due on {{expected}} and has not arrived yet. It is still on its way.\n\nFollow it here: {{link}}"),
            },
            ["assistant_digest"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Your weekly business digest", "{{digest}}"),
                ["email"] = ("Your weekly business digest", "Hi {{name}},\n\n{{digest}}\n\n{{link}}"),
            },
            ["seller_restock"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Restock {{item}}", "{{item}} has {{stock}} left and sold {{sold}} in the last {{days}} days, so it may run out in about {{left}} days. Consider adding about {{suggest}} units."),
                ["email"] = ("Restock {{item}}", "Hi {{name}},\n\n{{item}} has {{stock}} left and sold {{sold}} in the last {{days}} days, so it may run out in about {{left}} days. Consider adding about {{suggest}} units.\n\n{{link}}"),
            },
            ["seller_tracking_reminder"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Add tracking for order {{order_number}}", "You marked it shipped {{hours}} hours ago but no tracking number is on it. Add the courier and tracking number so the customer can follow the parcel."),
                ["email"] = ("Add tracking for order {{order_number}}", "Hi {{name}},\n\nOrder {{order_number}} was marked shipped {{hours}} hours ago but has no tracking number. Add the courier and tracking number.\n\n{{link}}"),
            },
            ["seller_ship_reminder"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Order {{order_number}} is waiting to ship", "You confirmed it {{hours}} hours ago. Ship it and add the tracking number so the customer is not left waiting."),
                ["email"] = ("Order {{order_number}} is waiting to ship", "Hi {{name}},\n\nYou confirmed order {{order_number}} {{hours}} hours ago and it has not shipped yet. Ship it and add the tracking number so the customer is not left waiting.\n\n{{link}}"),
            },
            ["review_reminder"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("How was {{item}}?", "Tell other shoppers what you think. It takes a minute."),
                ["email"] = ("How was {{item}}?", "Hi {{name}},\n\nTell other shoppers what you think of {{item}}. It takes a minute.\n\n{{link}}"),
            },
            ["points_expiring"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("{{points}} points expire soon", "{{points}} of your loyalty points expire within {{days}} days. Use them at checkout."),
                ["email"] = ("{{points}} points expire soon", "Hi {{name}},\n\n{{points}} of your loyalty points expire within {{days}} days. Use them on your next order.\n\n{{link}}"),
            },
            ["saved_search_match"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("New for your search: {{query}}", "{{item}}{{more}} just arrived."),
            },
            ["gift_card_refunded"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Gift card refunded", "Your gift card purchase of {{amount}} was refunded (reference {{reference}})."),
                ["email"] = ("Your gift card was refunded", "Hi {{name}},\n\nYour gift card purchase of {{amount}} was refunded. Payment reference: {{reference}}.\n\nThe card can no longer be used."),
            },
            ["gift_card_bought"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["email"] = ("Your {{brand}} gift card", "Hi {{name}},\n\nThank you. Your gift card for {{amount}} is ready.\n\nCode: {{code}}\nValid until {{expires}}\n\nUse it at checkout, or see the balance here: {{link}}"),
            },
            ["marketing_message"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("{{title}}", "{{message}}"),
            },
            ["order_cancelled"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Order cancelled", "{{item}} was cancelled: {{reason}}."),
                ["email"] = ("Cancelled: part of order {{order_number}}", "Hi {{name}},\n\n{{item}} was cancelled ({{reason}}). {{refund_text}}\n\n{{link}}"),
                ["sms"] = ("", "Part of your {{brand}} order {{order_number}} was cancelled. {{refund_text}}"),
            },
            ["refund_processed"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Refund started", "We have refunded {{amount}} for order {{order_number}}. It reaches your account in 5 to 7 working days."),
                ["email"] = ("Refund of {{amount}} started", "Hi {{name}},\n\nWe have refunded {{amount}} for order {{order_number}}. It reaches your original payment method in 5 to 7 working days."),
            },
            ["return_update"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return {{return_number}}: {{status}}", "{{message}}"),
                ["email"] = ("Your return {{return_number}}: {{status}}", "Hi {{name}},\n\n{{message}}\n\n{{link}}"),
            },
            ["ticket_reply"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Reply on ticket {{ticket_number}}", "Our team replied to your request: {{subject}}."),
                ["email"] = ("Reply on your request {{ticket_number}}", "Hi {{name}},\n\nWe replied to your request \"{{subject}}\".\n\n{{link}}"),
            },
            ["seller_new_order"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("New order {{order_number}}", "{{items}} for {{amount}}. Confirm it from your orders page."),
                ["email"] = ("New order {{order_number}} on {{brand}}", "You have a new order {{order_number}} ({{items}}) for {{amount}}. Please confirm and ship it within {{dispatch_days}} days.\n\n{{link}}"),
                ["sms"] = ("", "New {{brand}} order {{order_number}} for {{amount}}. Please confirm and ship on time."),
            },
            ["seller_order_cancelled"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Order {{order_number}} cancelled", "The customer cancelled {{order_number}}. Do not ship it."),
                ["email"] = ("Do not ship: order {{order_number}} cancelled", "Order {{order_number}} was cancelled ({{reason}}). Do not ship it.\n\n{{link}}"),
            },
            ["seller_return_requested"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return requested on {{order_number}}", "Reason: {{reason}}. Review it from your returns page."),
                ["email"] = ("Return requested on {{order_number}}", "A customer asked to return items from {{order_number}}. Reason: {{reason}}.\n\n{{link}}"),
            },
            ["seller_kyc_update"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Seller account {{status}}", "{{message}}"),
                ["email"] = ("Your {{brand}} seller account: {{status}}", "{{message}}\n\n{{link}}"),
            },
            ["listing_update"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Listing {{status}}", "{{title}}: {{message}}"),
                ["email"] = ("Your listing was {{status}}", "{{title}}\n\n{{message}}\n\n{{link}}"),
            },
            ["payout_sent"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Payout {{payout_number}} sent", "{{amount}} was sent to your bank account ending {{last4}}. UTR {{utr}}."),
                ["email"] = ("Payout of {{amount}} sent", "We have sent {{amount}} to your bank account ending {{last4}} (UTR {{utr}}).\n\n{{link}}"),
            },
            ["staff_message"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("{{subject}}", "{{message}}"),
                ["email"] = ("{{subject}}", "Hi {{name}},\n\n{{message}}\n\n{{link}}"),
            },
            ["security_notice"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Security notice: {{what}}", "{{message}} If this was not you or someone you asked, contact {{brand}} support at once."),
                ["email"] = ("Security notice from {{brand}}: {{what}}", "Hi {{name}},\n\n{{message}}\n\nIf this was not you or someone you asked, contact {{brand}} support at once so we can secure your account."),
                ["sms"] = ("", "{{brand}} security notice: {{what}}. Not you? Contact support at once."),
            },
            ["product_live"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Your product is live", "{{item}} is now live in the shop."),
            },
            ["low_stock"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Low stock", "{{count}} of your product options have {{threshold}} or fewer units left."),
            },
            ["back_in_stock"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Back in stock", "{{item}} is available again. Order before it sells out."),
                ["email"] = ("Back in stock: {{item}}", "Hi {{name}},\n\n{{item}} is back in stock at {{price}}. Stocks can run out again, so order soon.\n\n{{link}}"),
            },
            ["price_drop"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Price dropped", "{{item}} in your wishlist is now {{price}} (was {{old_price}})."),
                ["email"] = ("Price drop: {{item}} is now {{price}}", "Hi {{name}},\n\n{{item}}, which you saved, is now {{price}} (it was {{old_price}} when you saved it).\n\n{{link}}"),
            },
            ["question_answered"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Your question was answered", "{{answerer}} answered your question about {{item}}."),
                ["email"] = ("Answer to your question about {{item}}", "Hi {{name}},\n\nYou asked: {{question}}\n\n{{answerer}} answered: {{answer}}\n\n{{link}}"),
            },
            ["seller_new_question"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("New customer question", "A shopper asked about {{item}}: {{question}}"),
                ["email"] = ("A shopper asked about {{item}}", "A shopper asked: {{question}}\n\nAnswer it from your seller hub so others see it too.\n\n{{link}}"),
            },
            ["delivery_kyc_update"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery partner account {{status}}", "{{message}}"),
                ["sms"] = ("", "{{brand}} delivery partner account {{status}}. {{message}}"),
            },
            ["delivery_new_offer"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("New delivery request", "Pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}. {{fee}}{{cod}}. Accept within {{seconds}} seconds."),
            },
            ["delivery_assigned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery assigned to you", "{{order_number}}: pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}."),
            },
            ["delivery_trip_cancelled"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery cancelled: {{order_number}}", "{{message}}"),
            },
            ["delivery_partner_assigned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery partner assigned", "{{partner}} will deliver {{item}}. You can track the delivery on your order page."),
            },
            ["seller_pickup_assigned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Pickup assigned: {{order_number}}", "{{partner}} ({{vehicle}}) will pick up {{order_number}}. Give the package against pickup code {{code}}."),
            },
            ["delivery_out_for_delivery"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Out for delivery", "{{item}} is on the way with {{partner}}. Share OTP {{otp}} only when you receive the package."),
                ["sms"] = ("", "{{brand}}: {{item}} is out for delivery with {{partner}}. Share OTP {{otp}} only when you receive it."),
                ["email"] = ("Out for delivery: {{item}}", "Hi {{name}},\n\n{{item}} is on the way with {{partner}}.\n\nYour delivery OTP is {{otp}}. Share it only when you have the package in your hands.\n\nTrack it here: {{link}}"),
            },
            ["delivery_arriving"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Your delivery partner has arrived", "{{partner}} is at your address with {{item}}. Keep OTP {{otp}} ready."),
            },
            ["seller_package_delivered"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivered: {{order_number}}", "{{partner}} delivered {{order_number}} to the customer."),
            },
            ["delivery_rate"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("How was your delivery?", "Rate {{partner}}'s delivery of {{item}}. It takes a second."),
            },
            ["delivery_failed"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery attempt failed", "We could not deliver {{item}}: {{reason}}. We will try again or contact you."),
                ["sms"] = ("", "{{brand}}: we could not deliver {{item}} ({{reason}}). We will contact you."),
            },
            ["delivery_payout_paid"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Payout {{amount}} paid", "Your earnings for {{period}} were paid. Reference {{reference}}."),
                ["sms"] = ("", "{{brand}}: your delivery earnings {{amount}} for {{period}} were paid. Ref {{reference}}."),
            },
            ["staff_delivery_kyc"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery partner to verify", "{{name}} ({{city}}) submitted documents. Check them in Delivery → Partners."),
            },
            ["staff_delivery_bank"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Partner payout details changed", "{{name}} ({{phone}}) changed their bank or UPI details. Check them before the next payout."),
            },
            ["staff_delivery_unassigned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("No delivery partner took {{order_number}}", "{{reason}} Assign it by hand in Delivery → Queue."),
            },
            ["staff_review"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("{{subject}}", "{{message}}"),
            },
            ["staff_ticket"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("{{subject}}", "{{message}}"),
            },
            ["staff_delivery_stuck"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery stuck: {{order_number}}", "It has been '{{status}}' for {{minutes}} minutes with {{partner}}."),
            },
            ["staff_delivery_ready"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Ready for pickup: {{order_number}}", "{{store}} has a package ready for pickup ({{pickup_area}} to {{drop_area}}). Assign a partner in Delivery → Queue."),
            },
            ["staff_delivery_failed"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Delivery failed: {{order_number}}", "{{partner}} could not deliver: {{reason}}. Choose to try again or return it to the seller."),
            },
            ["seller_package_returned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Package returned: {{order_number}}", "{{partner}} returned {{order_number}} to your store ({{reason}}). The stock is back in your inventory."),
            },
            ["delivery_new_return_pickup"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("New return pickup", "Collect a return from a customer in {{drop_area}} and bring it to {{store}} ({{pickup_area}}). {{fee}}. Accept within {{seconds}} seconds."),
            },
            ["delivery_return_pickup_assigned"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return pickup assigned to you", "{{order_number}}: collect the return from a customer in {{drop_area}} and bring it to {{store}}."),
            },
            ["return_pickup_scheduled"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return pickup on the way", "{{partner}} will collect your return {{return_number}}. Keep the item packed and give pickup code {{code}} when you hand it over."),
                ["sms"] = ("", "{{brand}}: {{partner}} will collect your return {{return_number}}. Pickup code {{code}}."),
            },
            ["return_pickup_failed"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return pickup missed: {{return_number}}", "We could not collect your return ({{reason}}). We will arrange another pickup."),
            },
            ["seller_return_arriving"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return on its way: {{return_number}}", "{{partner}} collected return {{return_number}} ({{order_number}}) and is bringing it to you. Give pickup code {{code}} when you receive it."),
            },
            ["seller_return_delivered"] = new Dictionary<string, (string Subject, string Body)>
            {
                ["inapp"] = ("Return delivered: {{return_number}}", "{{partner}} brought return {{return_number}} to your store. Check the item, then mark it received to refund the customer."),
            },
        };
}
