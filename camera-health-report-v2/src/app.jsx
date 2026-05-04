import React from "react";
import { createRoot } from "react-dom/client";
import CameraHealthReport from "./components/CameraHealthReport";
import "./styles.css";

let root = null;

geotab.addin.cameraHealthReportV2 = () => {
    let currentApi = null;

    return {
        initialize(api, state, callback) {
            const container = document.getElementById("cameraHealthReportV2");
            root = createRoot(container);
            callback();
        },

        focus(api, state) {
            currentApi = api;
            root.render(<CameraHealthReport geotabApi={currentApi} />);
        },

        blur() {
            root.render(null);
            currentApi = null;
        },
    };
};
