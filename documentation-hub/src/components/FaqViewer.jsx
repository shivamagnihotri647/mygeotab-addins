import React, { useEffect, useMemo, useState } from "react";

// Turns [text](https://...), bare https:// URLs and email addresses into links. Only http(s) and mailto
// are allowed, and everything is rendered as React nodes, never as HTML.
const INLINE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])|([\w.+-]+@[\w-]+\.[\w.-]+[A-Za-z])/g;

function renderInline(text) {
    const nodes = [];
    let last = 0;
    let match;
    INLINE.lastIndex = 0;
    while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const label = match[1] || match[3] || match[4];
        const href = match[2] || match[3] || "mailto:" + match[4];
        nodes.push(
            <a key={match.index} className="dh-link" href={href} target="_blank" rel="noopener noreferrer">
                {label}
            </a>
        );
        last = match.index + match[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

function renderAnswer(answer) {
    return String(answer)
        .split(/\n{2,}/)
        .map((block, i) => {
            const lines = block.split("\n");
            if (lines.every((line) => line.startsWith("\u2022 "))) {
                return (
                    <ul key={i} className="dh-faq-list">
                        {lines.map((line, j) => (
                            <li key={j}>{renderInline(line.slice(2))}</li>
                        ))}
                    </ul>
                );
            }
            return <p key={i}>{renderInline(block)}</p>;
        });
}

/**
 * FAQ file format (content/<lang>/faq.json):
 *   { "sections": [ { "title": "...", "items": [ { "q": "...", "a": "Paragraph one.\n\nParagraph two." } ] } ] }
 * Answers are plain text: a blank line starts a new paragraph, lines starting with "\u2022 " form a bullet list,
 * and [text](url) or a bare URL or email becomes a link. They are rendered as text, never as HTML.
 */
export default function FaqViewer({ url, ui }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(false);
    const [query, setQuery] = useState("");

    useEffect(() => {
        let cancelled = false;
        setData(null);
        setError(false);
        fetch(url, { cache: "no-cache" })
            .then((res) => {
                if (!res.ok) throw new Error("faq " + res.status);
                return res.json();
            })
            .then((json) => !cancelled && setData(json))
            .catch(() => !cancelled && setError(true));
        return () => {
            cancelled = true;
        };
    }, [url]);

    const needle = query.trim().toLowerCase();
    const sections = useMemo(() => {
        if (!data) return [];
        return (data.sections || [])
            .map((section) => ({
                ...section,
                items: (section.items || []).filter(
                    (item) => !needle || (item.q + " " + item.a).toLowerCase().includes(needle)
                ),
            }))
            .filter((section) => section.items.length > 0);
    }, [data, needle]);
    const total = sections.reduce((n, s) => n + s.items.length, 0);

    if (error) return <p className="dh-message dh-message-error" role="alert">{ui.docError}</p>;
    if (!data) return <p className="dh-message" role="status">{ui.loading}</p>;

    return (
        <section className="dh-faq">
            <label className="dh-label" htmlFor="dh-faq-search">{ui.searchLabel}</label>
            <input
                id="dh-faq-search"
                className="dh-input"
                type="search"
                value={query}
                placeholder={ui.searchPlaceholder}
                onChange={(e) => setQuery(e.target.value)}
            />
            {needle && <p className="dh-count" role="status">{total === 0 ? ui.noResults : ui.results(total)}</p>}

            {sections.map((section) => (
                <div className="dh-faq-section" key={section.title}>
                    <h2 className="dh-faq-heading">{section.title}</h2>
                    {section.items.map((item) => (
                        <details className="dh-faq-item" key={item.q} open={Boolean(needle)}>
                            <summary className="dh-faq-q">{item.q}</summary>
                            <div className="dh-faq-a">{renderAnswer(item.a)}</div>
                        </details>
                    ))}
                </div>
            ))}
        </section>
    );
}
