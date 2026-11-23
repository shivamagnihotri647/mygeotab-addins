// Where the documents live. MyGeotab runs add-ins inside its own page, so window.location points at
// my.geotab.com and cannot be used to find the content folder. The add-in's own script URL is reliable:
// it is always served from the add-in's host. This must be read while the script is first running
// (document.currentScript is empty afterwards), so it is captured at module load.

const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "";

// Used only if the script URL cannot be determined. Set DH_CONTENT_BASE when building for another host.
const BUILT_IN_DEFAULT = __DH_DEFAULT_CONTENT_BASE__;

export function getContentBase() {
    if (window.DOCUMENTATION_HUB_CONTENT_BASE) return window.DOCUMENTATION_HUB_CONTENT_BASE; // local test page
    if (/\/dist\/scripts\/[^/]+$/.test(SCRIPT_SRC)) return new URL("../../content/", SCRIPT_SRC).href;
    return BUILT_IN_DEFAULT;
}
