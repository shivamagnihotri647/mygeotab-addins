/**
 * MyGeotab Add-In Entry Point — Bulk Group Deletion
 *
 * Bridges the MyGeotab vanilla lifecycle (initialize/focus/blur)
 * with the React component tree.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import BulkGroupDeletion from "./components/BulkGroupDeletion";
import "./styles.css";

let root = null;

geotab.addin.bulkGroupDeletion = () => {
    let currentApi = null;

    return {
        initialize(api, state, callback) {
            const container = document.getElementById("bulkGroupDeletion");
            root = createRoot(container);
            callback();
        },

        focus(api, state) {
            currentApi = api;
            root.render(<BulkGroupDeletion geotabApi={currentApi} />);
        },

        blur() {
            root.render(null);
            currentApi = null;
        },
    };
};
