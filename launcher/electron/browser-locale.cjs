const languages = require("./languages.json");

function localeForEmbeddedBrowser(language) {
  if (!Object.hasOwn(languages, language)) return null;
  const locale = languages[language].locale;
  return locale === "en" ? "en-US" : locale;
}

module.exports = { localeForEmbeddedBrowser };
