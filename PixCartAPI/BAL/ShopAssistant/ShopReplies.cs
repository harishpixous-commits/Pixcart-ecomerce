using System.Text.Json.Nodes;

namespace BAL.ShopAssistant;

/// <summary>Sentences for guided mode (no AI model), in English, Tamil and Hindi. Reference: shop_assistant/replies.py.</summary>
public static class ShopReplies
{
    private static readonly Dictionary<string, Dictionary<string, string>> T = new()
    {
        ["thanks"] = new() { ["en"] = "You're welcome! Is there anything else I can help with?",
            ["ta"] = "மகிழ்ச்சி! வேறு ஏதாவது உதவி வேண்டுமா?",
            ["hi"] = "आपका स्वागत है! क्या मैं और कुछ मदद कर सकता हूँ?" },
        ["bye"] = new() { ["en"] = "Thank you for shopping with {brand}. Have a great day!",
            ["ta"] = "{brand}-இல் வாங்கியதற்கு நன்றி. இனிய நாள்!",
            ["hi"] = "{brand} से खरीदारी के लिए धन्यवाद। आपका दिन शुभ हो!" },
        ["sign_in"] = new() { ["en"] = "Please sign in with your mobile number so I can see your orders. It takes a few seconds.",
            ["ta"] = "உங்கள் ஆர்டர்களைப் பார்க்க மொபைல் எண்ணுடன் உள்நுழையவும்.",
            ["hi"] = "आपके ऑर्डर देखने के लिए कृपया अपने मोबाइल नंबर से साइन इन करें।" },
        ["no_orders"] = new() { ["en"] = "I don't see any orders on this account yet. Would you like help finding something to buy?",
            ["ta"] = "இந்த கணக்கில் இன்னும் ஆர்டர் எதுவும் இல்லை. ஏதாவது தேட உதவட்டுமா?",
            ["hi"] = "इस खाते में अभी कोई ऑर्डर नहीं है। क्या मैं कुछ ढूँढने में मदद करूँ?" },
        ["orders_list"] = new() { ["en"] = "Here are your recent orders. Tap one for details, or tell me the order number.",
            ["ta"] = "உங்கள் சமீபத்திய ஆர்டர்கள் இதோ. விவரங்களுக்கு ஒன்றைத் தொடவும் அல்லது ஆர்டர் எண்ணைச் சொல்லவும்.",
            ["hi"] = "ये आपके हाल के ऑर्डर हैं। विवरण के लिए किसी पर टैप करें या ऑर्डर नंबर बताएँ।" },
        ["order_not_found"] = new() { ["en"] = "I couldn't find order {number} on your account. Please check the number; here are your recent orders.",
            ["ta"] = "உங்கள் கணக்கில் {number} ஆர்டர் இல்லை. எண்ணைச் சரிபார்க்கவும்; உங்கள் சமீபத்திய ஆர்டர்கள் இதோ.",
            ["hi"] = "आपके खाते में ऑर्डर {number} नहीं मिला। कृपया नंबर जाँचें; ये आपके हाल के ऑर्डर हैं।" },
        ["order_status"] = new() { ["en"] = "Order {number} is {status}.",
            ["ta"] = "ஆர்டர் {number}: {status}.",
            ["hi"] = "ऑर्डर {number}: {status}।" },
        ["pkg_shipped"] = new() { ["en"] = "Package {number} is with {courier}{tracking}.",
            ["ta"] = "பேக்கேஜ் {number} {courier} மூலம் வருகிறது{tracking}.",
            ["hi"] = "पैकेज {number} {courier} के पास है{tracking}।" },
        ["pkg_expected"] = new() { ["en"] = "Expected delivery: {date}.",
            ["ta"] = "எதிர்பார்க்கப்படும் டெலிவரி: {date}.",
            ["hi"] = "अनुमानित डिलीवरी: {date}।" },
        ["cancel_ready"] = new() { ["en"] = "I've prepared the cancellation. Please check the details and press **Yes, cancel** to confirm.",
            ["ta"] = "ரத்து செய்யத் தயார். விவரங்களைச் சரிபார்த்து **Yes, cancel** அழுத்தவும்.",
            ["hi"] = "रद्द करने की तैयारी हो गई है। विवरण जाँचें और पुष्टि के लिए **Yes, cancel** दबाएँ।" },
        ["cancel_pick"] = new() { ["en"] = "Which order would you like to cancel? These can still be cancelled. Tell me the order number.",
            ["ta"] = "எந்த ஆர்டரை ரத்து செய்ய வேண்டும்? இவற்றை இன்னும் ரத்து செய்யலாம். ஆர்டர் எண்ணைச் சொல்லவும்.",
            ["hi"] = "आप कौन सा ऑर्डर रद्द करना चाहते हैं? ये अभी रद्द हो सकते हैं। ऑर्डर नंबर बताएँ।" },
        ["cancel_none"] = new() { ["en"] = "None of your orders can be cancelled now: they have shipped or are already cancelled. Shipped items can be returned after delivery if they are returnable.",
            ["ta"] = "உங்கள் ஆர்டர்கள் எதையும் இப்போது ரத்து செய்ய முடியாது. டெலிவரிக்குப் பிறகு திருப்பி அனுப்பலாம்.",
            ["hi"] = "अभी आपका कोई ऑर्डर रद्द नहीं हो सकता। डिलीवरी के बाद लौटाने योग्य सामान वापस किया जा सकता है।" },
        ["return_ready"] = new() { ["en"] = "You can return items from order {number} until {date}. Open the order and press **Return items**; the seller arranges the pickup.",
            ["ta"] = "ஆர்டர் {number}-இல் உள்ள பொருட்களை {date} வரை திருப்பி அனுப்பலாம். ஆர்டரைத் திறந்து **Return items** அழுத்தவும்.",
            ["hi"] = "ऑर्डर {number} का सामान {date} तक लौटा सकते हैं। ऑर्डर खोलें और **Return items** दबाएँ।" },
        ["return_none"] = new() { ["en"] = "I don't see a delivered order that is still within its return window.",
            ["ta"] = "திருப்பி அனுப்பும் காலத்திற்குள் உள்ள டெலிவரி ஆன ஆர்டர் எதுவும் இல்லை.",
            ["hi"] = "लौटाने की अवधि में कोई डिलीवर हुआ ऑर्डर नहीं मिला।" },
        ["damaged_sorry"] = new() { ["en"] = "I'm sorry the item wasn't right.",
            ["ta"] = "பொருள் சரியாக இல்லாததற்கு வருந்துகிறோம்.",
            ["hi"] = "माफ़ कीजिए, सामान सही नहीं था।" },
        ["refunds"] = new() { ["en"] = "Here are your returns and refunds.",
            ["ta"] = "உங்கள் ரிட்டர்ன்கள் மற்றும் பணத்திரும்பல்கள் இதோ.",
            ["hi"] = "ये आपके रिटर्न और रिफंड हैं।" },
        ["no_refunds"] = new() { ["en"] = "There are no returns or refunds on your account yet.",
            ["ta"] = "உங்கள் கணக்கில் ரிட்டர்ன் அல்லது பணத்திரும்பல் எதுவும் இல்லை.",
            ["hi"] = "आपके खाते में अभी कोई रिटर्न या रिफंड नहीं है।" },
        ["tickets"] = new() { ["en"] = "Here are your support requests.",
            ["ta"] = "உங்கள் உதவிக் கோரிக்கைகள் இதோ.",
            ["hi"] = "ये आपके सहायता अनुरोध हैं।" },
        ["no_tickets"] = new() { ["en"] = "You have no support requests. Tell me what went wrong and I'll help or pass it to our team.",
            ["ta"] = "உதவிக் கோரிக்கை எதுவும் இல்லை. என்ன பிரச்சனை என்று சொல்லுங்கள்.",
            ["hi"] = "आपका कोई सहायता अनुरोध नहीं है। बताइए क्या समस्या है।" },
        ["ticket_form"] = new() { ["en"] = "I've filled in a request for our support team. Check it, change anything you like, and press **Send**. The team replies within 48 hours.",
            ["ta"] = "எங்கள் குழுவுக்கான கோரிக்கையை நிரப்பியுள்ளேன். சரிபார்த்து **Send** அழுத்தவும். 48 மணி நேரத்தில் பதில் வரும்.",
            ["hi"] = "मैंने सहायता टीम के लिए अनुरोध भर दिया है। जाँचें और **Send** दबाएँ। टीम 48 घंटे में जवाब देगी।" },
        ["products"] = new() { ["en"] = "Here are some options{price}.",
            ["ta"] = "சில தேர்வுகள் இதோ{price}.",
            ["hi"] = "ये कुछ विकल्प हैं{price}।" },
        ["no_products"] = new() { ["en"] = "I couldn't find products for “{query}”. Try other words, or browse the categories.",
            ["ta"] = "“{query}”-க்கு பொருட்கள் கிடைக்கவில்லை. வேறு சொற்களில் முயற்சிக்கவும்.",
            ["hi"] = "“{query}” के लिए उत्पाद नहीं मिले। दूसरे शब्दों से खोजें।" },
        ["ask_product"] = new() { ["en"] = "What are you looking for? For example: “running shoes under 2000” or “pressure cooker”.",
            ["ta"] = "என்ன தேடுகிறீர்கள்? உதாரணம்: “running shoes under 2000”.",
            ["hi"] = "आप क्या ढूँढ रहे हैं? जैसे: “running shoes under 2000”।" },
        ["fallback"] = new() { ["en"] = "I'm not sure I understood. I can track orders, cancel before shipping, help with returns and refunds, find products, or connect you to our team.",
            ["ta"] = "எனக்குச் சரியாகப் புரியவில்லை. ஆர்டர் நிலை, ரத்து, ரிட்டர்ன், பணத்திரும்பல், பொருள் தேடல் அல்லது எங்கள் குழுவுடன் இணைப்பு — இவற்றில் உதவுவேன்.",
            ["hi"] = "मैं ठीक से समझ नहीं पाया। मैं ऑर्डर ट्रैक, रद्द, रिटर्न, रिफंड, उत्पाद खोज या टीम से जोड़ने में मदद कर सकता हूँ।" },
        ["handoff"] = new() { ["en"] = "Would you like me to pass this to our support team?",
            ["ta"] = "இதை எங்கள் உதவிக் குழுவுக்கு அனுப்பட்டுமா?",
            ["hi"] = "क्या मैं इसे सहायता टीम को भेज दूँ?" },
        ["feature_off"] = new() { ["en"] = "I can't do that in chat right now. You can do it on the {page} page.",
            ["ta"] = "இதை இப்போது சாட்டில் செய்ய முடியாது. {page} பக்கத்தில் செய்யலாம்.",
            ["hi"] = "यह अभी चैट में नहीं हो सकता। आप इसे {page} पेज पर कर सकते हैं।" },
        ["guest_ticket"] = new() { ["en"] = "To raise a request, please sign in first so our team can reply to you. {grievance}",
            ["ta"] = "கோரிக்கை அனுப்ப முதலில் உள்நுழையவும். {grievance}",
            ["hi"] = "अनुरोध भेजने के लिए पहले साइन इन करें। {grievance}" },
    };

    public static readonly Dictionary<string, string[]> Chips = new()
    {
        ["en"] = ["Track my order", "Return an item", "Refund status", "Find a product", "Talk to support"],
        ["ta"] = ["என் ஆர்டர் எங்கே?", "ரிட்டர்ன்", "பணம் திரும்ப", "பொருள் தேடு", "உதவிக் குழு"],
        ["hi"] = ["मेरा ऑर्डर कहाँ है?", "रिटर्न", "रिफंड स्टेटस", "उत्पाद खोजें", "सहायता टीम"],
    };

    /// <summary>{placeholder} substitution; falls back to English when a language or placeholder is missing.</summary>
    public static string T_(string key, string lang, params (string K, object V)[] kw)
    {
        var table = T[key];
        var text = table.GetValueOrDefault(lang) ?? table["en"];
        var outp = text;
        foreach (var (k, v) in kw) outp = outp.Replace("{" + k + "}", v?.ToString());
        return outp.Contains('{') && lang != "en" ? Fill(table["en"], kw) : outp;

        static string Fill(string t, (string K, object V)[] kw)
        {
            foreach (var (k, v) in kw) t = t.Replace("{" + k + "}", v?.ToString());
            return t;
        }
    }

    public static JsonObject ChipsCard(IEnumerable<string> items) =>
        new() { ["type"] = "chips", ["items"] = new JsonArray(items.Take(6).Select(i => (JsonNode)JsonValue.Create(i)).ToArray()) };
}
