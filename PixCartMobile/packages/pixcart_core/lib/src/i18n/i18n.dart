// Translation hook. The website translates pages through /api/i18n/translate (lib/i18n.ts). The apps call `t()` on
// every fixed text so a later module can plug the same translations in without touching the screens.

typedef Translator = String Function(String text);

Translator _translator = _identity;

String _identity(String text) => text;

/// The text in the shopper's language (English until a translator is installed).
String t(String text) => _translator(text);

/// Installs a translator (null: back to English).
void setTranslator(Translator? translator) => _translator = translator ?? _identity;
