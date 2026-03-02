/**
 * MyGeotab Add-In Entry Point
 *
 * This file bridges the MyGeotab vanilla lifecycle (initialize/focus/blur)
 * with our React component tree. The `api` object from MyGeotab is passed
 * as a prop so React manages all rendering and state.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import BulkExceptionDismiss from "./components/BulkExceptionDismiss";
import "./styles.css";

// ── Mount container ──
// MyGeotab provides a <div id="bulkExceptionDismiss"> in the page.
// We render our React tree into it.

let root = null;

geotab.addin.bulkExceptionDismiss = () => {
    let currentApi = null;

    return {
        /**
         * Called once when the add-in is first loaded.
         * We create the React root here but don't render yet (no api).
         */
        initialize(api, state, callback) {
            const container = document.getElementById("bulkExceptionDismiss");
            root = createRoot(container);
            callback();
        },

        /**
         * Called every time the user navigates TO this add-in page.
         * We render (or re-render) the React tree with the fresh api.
         */
        focus(api, state) {
            currentApi = api;
            root.render(<BulkExceptionDismiss geotabApi={currentApi} />);
        },

        /**
         * Called when the user navigates AWAY from this page.
         * Unmount React to clean up all state, intervals, listeners.
         */
        blur() {
            root.render(null);
            currentApi = null;
        },
    };
};
