/**
 * MyGeotab Add-In Entry Point — Bulk User Upload
 *
 * Bridges the MyGeotab vanilla lifecycle (initialize/focus/blur)
 * with the React component tree.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import BulkUserUpload from "./components/BulkUserUpload";
import "./styles.css";

let root = null;

geotab.addin.bulkUserUpload = () => {
    let currentApi = null;

    return {
        initialize(api, state, callback) {
            const container = document.getElementById("bulkUserUpload");
            root = createRoot(container);
            callback();
        },

        focus(api, state) {
            currentApi = api;
            root.render(<BulkUserUpload geotabApi={currentApi} />);
        },

        blur() {
            root.render(null);
            currentApi = null;
        },
    };
};
