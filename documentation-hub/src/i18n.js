// Interface strings. Document content is translated separately, in content/<lang>/.
export const STRINGS = {
    en: {
        title: "Documentation",
        documents: "Documents",
        language: "Language",
        loading: "Loading…",
        loadError: "The documents could not be loaded. Please try again later or contact support.",
        docError: "This document could not be loaded.",
        noDocs: "No documents are available.",
        openNewTab: "Open in new tab",
        download: "Download",
        searchLabel: "Search questions",
        searchPlaceholder: "Type to filter questions",
        results: (n) => (n === 1 ? "1 question found" : n + " questions found"),
        noResults: "No questions match your search.",
        fallbackNotice: (lang) =>
            "This document is not available in your language yet. Showing the " + ({ en: "English", fr: "French" }[lang] || lang) + " version.",
        english: "English",
        french: "Français",
        sampleNotice: "Sample content",
    },
    fr: {
        title: "Documentation",
        documents: "Documents",
        language: "Langue",
        loading: "Chargement…",
        loadError: "Les documents n'ont pas pu être chargés. Veuillez réessayer plus tard ou contacter le soutien.",
        docError: "Ce document n'a pas pu être chargé.",
        noDocs: "Aucun document n'est disponible.",
        openNewTab: "Ouvrir dans un nouvel onglet",
        download: "Télécharger",
        searchLabel: "Rechercher dans les questions",
        searchPlaceholder: "Saisissez pour filtrer les questions",
        results: (n) => (n === 1 ? "1 question trouvée" : n + " questions trouvées"),
        noResults: "Aucune question ne correspond à votre recherche.",
        fallbackNotice: (lang) =>
            "Ce document n'est pas encore disponible dans votre langue. Affichage de la version " + ({ en: "anglaise", fr: "française" }[lang] || lang) + ".",
        english: "English",
        french: "Français",
        sampleNotice: "Contenu d'exemple",
    },
};

export const SUPPORTED = ["en", "fr"];

/** "fr-CA", "FR", "français" -> "fr"; anything unsupported -> null. */
export function normalizeLang(value) {
    const code = String(value || "").trim().toLowerCase();
    if (code.startsWith("fr")) return "fr";
    if (code.startsWith("en")) return "en";
    return null;
}

/** Pick text for a language from {en:..., fr:...}, falling back to the default. */
export function pick(map, lang, fallback = "en") {
    if (!map) return "";
    if (typeof map === "string") return map;
    return map[lang] || map[fallback] || Object.values(map)[0] || "";
}
