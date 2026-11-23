/**
 * MyGeotab Add-In Entry Point
 *
 * Bridges the MyGeotab lifecycle (initialize/focus/blur) with the React tree.
 * The documents themselves are NOT bundled: the add-in loads them at runtime from
 * the content folder next to it (see content/manifest.json), so the document owner
 * can change content without rebuilding or reinstalling the add-in.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import DocumentationHub from "./components/DocumentationHub";
import "./styles.css";

let root = null;

geotab.addin.documentationHub = () => {
    return {
        initialize(api, state, callback) {
            root = createRoot(document.getElementById("documentationHub"));
            callback();
        },

        focus(api) {
            root.render(<DocumentationHub geotabApi={api} />);
        },

        blur() {
            root.render(null);
        },
    };
};
