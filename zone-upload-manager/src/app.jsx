import React from "react";
import { createRoot } from "react-dom/client";
import ZoneUploadManager from "./components/ZoneUploadManager";
import "./styles.css";

let root = null;

geotab.addin.zoneUploadManager = () => {
  let currentApi = null;

  return {
    initialize(api, state, callback) {
      const container = document.getElementById("zoneUploadManager");
      root = createRoot(container);
      callback();
    },

    focus(api, state) {
      currentApi = api;
      root.render(<ZoneUploadManager geotabApi={currentApi} />);
    },

    blur() {
      if (root) root.render(null);
      currentApi = null;
    },
  };
};
