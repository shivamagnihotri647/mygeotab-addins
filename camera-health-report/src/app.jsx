import React from "react";
import { createRoot } from "react-dom/client";
import CameraHealthReport from "./components/CameraHealthReport";
import "./styles.css";

let root = null;

geotab.addin.cameraHealthReport = () => {
    let currentApi = null;

    return {
        initialize(api, state, callback) {
            const container = document.getElementById("cameraHealthReport");
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
