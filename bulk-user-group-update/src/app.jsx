/**
 * MyGeotab Add-In Entry Point — Bulk User Group Update
 *
 * Bridges the MyGeotab vanilla lifecycle (initialize/focus/blur)
 * with the React component tree.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import BulkUserGroupUpdate from "./components/BulkUserGroupUpdate";
import "./styles.css";

let root = null;

geotab.addin.bulkUserGroupUpdate = () => {
    let currentApi = null;

    return {
        initialize(api, state, callback) {
            const container = document.getElementById("bulkUserGroupUpdate");
            root = createRoot(container);
            callback();
        },

        focus(api, state) {
            currentApi = api;
            root.render(<BulkUserGroupUpdate geotabApi={currentApi} />);
        },

        blur() {
            root.render(null);
            currentApi = null;
        },
    };
};
