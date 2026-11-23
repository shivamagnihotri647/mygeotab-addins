import React from "react";

/** Shows a PDF in the browser's own viewer, with links to open or save it. */
export default function PdfViewer({ url, title, ui }) {
    return (
        <section className="dh-pdf" aria-label={title}>
            <div className="dh-pdf-actions">
                <a className="dh-link" href={url} target="_blank" rel="noopener noreferrer">
                    {ui.openNewTab}
                </a>
                <a className="dh-link" href={url} download>
                    {ui.download}
                </a>
            </div>
            <iframe className="dh-pdf-frame" src={url} title={title} />
        </section>
    );
}
