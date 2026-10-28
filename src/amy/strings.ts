// A.M.Y Loader wording, layered over iloader's English strings at runtime so
// iloader's locale files stay untouched (keeps upstream merges conflict-free).
import i18n from "../i18next";

const AMY_EN = {
  app: { logo_alt: "A.M.Y Loader logo" },
  apple_id: {
    max_certs_desc: "A.M.Y Loader will revoke your existing certificates and generate a new one.",
  },
  settings: {
    dont_use_keyring_message:
      "This makes A.M.Y Loader less secure by storing pairing files, anisette state, and certificates on disk. Enable this only if the default keyring storage doesn't work and you understand the risks.",
  },
};

function apply() {
  // deep-merge into the existing English bundle, overwriting only these keys
  i18n.addResourceBundle("en", "translation", AMY_EN, true, true);
  const fs = i18n.t("error.suggestions.filesystem", { returnObjects: true, lng: "en" });
  if (Array.isArray(fs) && fs.length) {
    const patched = [...fs];
    patched[0] = "Make sure A.M.Y Loader has permission to read and write files on your system.";
    i18n.addResourceBundle("en", "translation", { error: { suggestions: { filesystem: patched } } }, true, true);
  }
}

if (i18n.isInitialized) apply();
else i18n.on("initialized", apply);
