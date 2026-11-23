import React, { useCallback, useEffect, useMemo, useState } from "react";
import { STRINGS, SUPPORTED, normalizeLang, pick } from "../i18n";
import PdfViewer from "./PdfViewer";
import FaqViewer from "./FaqViewer";

// Content lives next to the add-in: .../documentation-hub/content/ (the add-in is served from .../dist/).
// A page can set window.DOCUMENTATION_HUB_CONTENT_BASE to read content from elsewhere (used by the local test page).
const CONTENT_BASE =
    window.DOCUMENTATION_HUB_CONTENT_BASE || new URL("../content/", window.location.href).href;
const LANG_KEY = "dh-lang";

function readSavedLang() {
    try {
        return normalizeLang(window.localStorage.getItem(LANG_KEY));
    } catch (e) {
        return null; // storage can be blocked; the page must still work
    }
}

function saveLang(lang) {
    try {
        window.localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
        /* ignore */
    }
}

/** Best guess at the user's language: saved choice, then their MyGeotab user record, then the browser. */
async function detectLanguage(api) {
    const saved = readSavedLang();
    if (saved) return saved;
    try {
        const session = await new Promise((resolve, reject) => api.getSession(resolve, reject));
        const users = await api.call("Get", { typeName: "User", search: { name: session.userName }, resultsLimit: 1 });
        const fromUser = normalizeLang(users && users[0] && users[0].language);
        if (fromUser) return fromUser;
    } catch (e) {
        /* fall through to the browser language */
    }
    return normalizeLang(navigator.language) || "en";
}

export default function DocumentationHub({ geotabApi }) {
    const [manifest, setManifest] = useState(null);
    const [error, setError] = useState(false);
    const [lang, setLang] = useState("en");
    const [selectedId, setSelectedId] = useState(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(CONTENT_BASE + "manifest.json", { cache: "no-cache" });
                if (!res.ok) throw new Error("manifest " + res.status);
                const data = await res.json();
                const detected = await detectLanguage(geotabApi);
                if (cancelled) return;
                setManifest(data);
                setLang(SUPPORTED.includes(detected) ? detected : data.defaultLanguage || "en");
                setSelectedId(data.documents && data.documents[0] ? data.documents[0].id : null);
            } catch (e) {
                if (!cancelled) setError(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [geotabApi]);

    const chooseLang = useCallback((next) => {
        setLang(next);
        saveLang(next);
    }, []);

    const ui = STRINGS[lang] || STRINGS.en;
    const defaultLang = (manifest && manifest.defaultLanguage) || "en";
    const doc = useMemo(
        () => (manifest ? manifest.documents.find((d) => d.id === selectedId) : null),
        [manifest, selectedId]
    );

    if (error) {
        return (
            <div className="dh-container" role="alert">
                <p className="dh-message dh-message-error">{ui.loadError}</p>
            </div>
        );
    }
    if (!manifest) {
        return (
            <div className="dh-container" role="status">
                <p className="dh-message">{ui.loading}</p>
            </div>
        );
    }

    // Use the document's file for the chosen language, or fall back to the default language.
    const file = doc ? doc.file[lang] || doc.file[defaultLang] : null;
    const usedFallback = doc && file && !doc.file[lang];
    const fileUrl = file ? new URL(file, CONTENT_BASE).href : null;
    const docTitle = doc ? pick(doc.title, lang, defaultLang) : "";

    return (
        <div className="dh-container" lang={lang}>
            <header className="dh-header">
                <h1 className="dh-title">{pick(manifest.title, lang, defaultLang) || ui.title}</h1>
                <div className="dh-lang" role="group" aria-label={ui.language}>
                    {SUPPORTED.map((code) => (
                        <button
                            key={code}
                            type="button"
                            className={"dh-lang-btn" + (lang === code ? " dh-lang-active" : "")}
                            aria-pressed={lang === code}
                            lang={code}
                            onClick={() => chooseLang(code)}
                        >
                            {code === "en" ? ui.english : ui.french}
                        </button>
                    ))}
                </div>
            </header>

            {manifest.sample && <p className="dh-sample">{ui.sampleNotice}</p>}

            {manifest.documents.length === 0 ? (
                <p className="dh-message">{ui.noDocs}</p>
            ) : (
                <div className="dh-layout">
                    <nav className="dh-nav" aria-label={ui.documents}>
                        <ul className="dh-nav-list">
                            {manifest.documents.map((d) => (
                                <li key={d.id}>
                                    <button
                                        type="button"
                                        className={"dh-nav-item" + (d.id === selectedId ? " dh-nav-active" : "")}
                                        aria-current={d.id === selectedId ? "page" : undefined}
                                        onClick={() => setSelectedId(d.id)}
                                    >
                                        <span className="dh-nav-title">{pick(d.title, lang, defaultLang)}</span>
                                        {d.description && (
                                            <span className="dh-nav-desc">{pick(d.description, lang, defaultLang)}</span>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <main className="dh-viewer" aria-live="polite">
                        {usedFallback && (
                            <p className="dh-notice">
                                {ui.fallbackNotice(defaultLang)}
                            </p>
                        )}
                        {doc && doc.type === "pdf" && fileUrl && (
                            <PdfViewer url={fileUrl} title={docTitle} ui={ui} />
                        )}
                        {doc && doc.type === "faq" && fileUrl && (
                            <FaqViewer key={fileUrl} url={fileUrl} ui={ui} />
                        )}
                    </main>
                </div>
            )}
        </div>
    );
}
