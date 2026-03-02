/**
 * Bulk Exception Dismiss — MyGeotab Add-In
 *
 * Dismisses exceptions in batches for a selected rule, device, and date range.
 */

geotab.addin.bulkExceptionDismiss = function () {
    "use strict";

    var api;
    var elContainer,
        elRuleSearch, elRuleSelect,
        elDeviceSearch, elDeviceSelect,
        elStartDate,
        elBtnFind, elBtnDismiss,
        elStatusLine, elErrorBox,
        elLogArea;

    var allRules = [];
    var allDevices = [];
    var foundExceptions = [];

    var BATCH_SIZE = 100;
    var RESULTS_LIMIT = 50000;
    var RATE_LIMIT_PAUSE_MS = 61000; // 61s pause between batches (API allows 100 calls/min)

    // ── Helpers ──

    function log(message, type) {
        var line = document.createElement("div");
        line.className = "bed-log-" + (type || "info");
        line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
        elLogArea.appendChild(line);
        elLogArea.scrollTop = elLogArea.scrollHeight;
    }

    function showStatus(message) {
        elStatusLine.textContent = message;
        elStatusLine.style.display = "block";
    }

    function hideStatus() {
        elStatusLine.style.display = "none";
    }

    function showError(message) {
        elErrorBox.textContent = message;
        elErrorBox.style.display = "block";
    }

    function hideError() {
        elErrorBox.style.display = "none";
    }

    function clearLog() {
        elLogArea.innerHTML = "";
    }

    function setDateConstraints() {
        var today = new Date().toISOString().split("T")[0];
        elStartDate.setAttribute("max", today);

        // Default to 30 days ago
        var d = new Date();
        d.setDate(d.getDate() - 30);
        elStartDate.value = d.toISOString().split("T")[0];
    }

    // ── Dropdown filtering ──

    function populateSelect(selectEl, items, placeholderText, includeAll) {
        selectEl.innerHTML = "";
        if (includeAll) {
            var allOpt = document.createElement("option");
            allOpt.value = "__ALL__";
            allOpt.textContent = "All Devices";
            selectEl.appendChild(allOpt);
        }
        if (items.length === 0) {
            var empty = document.createElement("option");
            empty.value = "";
            empty.disabled = true;
            empty.textContent = placeholderText || "No results";
            selectEl.appendChild(empty);
        } else {
            items.forEach(function (item) {
                var opt = document.createElement("option");
                opt.value = item.id;
                opt.textContent = item.name;
                selectEl.appendChild(opt);
            });
        }
    }

    function filterRules() {
        var term = elRuleSearch.value.toLowerCase();
        var filtered = allRules.filter(function (r) {
            return r.name.toLowerCase().indexOf(term) !== -1;
        });
        populateSelect(elRuleSelect, filtered, "No matching rules");
    }

    function filterDevices() {
        var term = elDeviceSearch.value.toLowerCase();
        var filtered = allDevices.filter(function (d) {
            return d.name.toLowerCase().indexOf(term) !== -1;
        });
        populateSelect(elDeviceSelect, filtered, "No matching devices", true);
    }

    // ── Data loading ──

    function loadData() {
        log("Loading rules and devices...");

        var rulesCall = new Promise(function (resolve, reject) {
            api.call("Get", {
                typeName: "Rule",
                resultsLimit: 50000
            }, function (result) {
                resolve(result);
            }, function (err) {
                reject(err);
            });
        });

        var devicesCall = new Promise(function (resolve, reject) {
            api.call("Get", {
                typeName: "Device",
                resultsLimit: 50000
            }, function (result) {
                resolve(result);
            }, function (err) {
                reject(err);
            });
        });

        Promise.all([rulesCall, devicesCall]).then(function (results) {
            // Rules: sort alphabetically
            allRules = results[0]
                .map(function (r) { return { id: r.id, name: r.name || r.id }; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); });

            // Devices: sort alphabetically
            allDevices = results[1]
                .map(function (d) { return { id: d.id, name: d.name || d.id }; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); });

            populateSelect(elRuleSelect, allRules, "No rules found");
            populateSelect(elDeviceSelect, allDevices, "No devices found", true);

            log("Loaded " + allRules.length + " rules and " + allDevices.length + " devices.", "success");
            elContainer.style.display = "block";
        }).catch(function (err) {
            log("Failed to load data: " + (err.message || err), "error");
            showError("Failed to load rules and devices. Please refresh the page.");
            elContainer.style.display = "block";
        });
    }

    // ── Find Exceptions ──

    function findExceptions() {
        hideError();
        hideStatus();
        foundExceptions = [];
        elBtnDismiss.disabled = true;

        // Validate rule selection
        var ruleId = elRuleSelect.value;
        if (!ruleId || ruleId === "__ALL__") {
            showError("Please select a rule.");
            return;
        }

        // Validate date
        var dateVal = elStartDate.value;
        if (!dateVal) {
            showError("Please select a start date.");
            return;
        }

        var fromDate = new Date(dateVal + "T00:00:00");
        var toDate = new Date();

        // Get selected device
        var deviceId = elDeviceSelect.value;
        var deviceName = deviceId && deviceId !== "__ALL__"
            ? elDeviceSelect.options[elDeviceSelect.selectedIndex].textContent
            : "All Devices";

        var ruleName = elRuleSelect.options[elRuleSelect.selectedIndex].textContent;

        log("Searching exceptions for rule: " + ruleName);
        log("Device: " + deviceName);
        log("Date range: " + fromDate.toLocaleDateString() + " to " + toDate.toLocaleDateString());

        elBtnFind.disabled = true;
        elBtnFind.textContent = "Searching...";

        var search = {
            fromDate: fromDate.toISOString(),
            toDate: toDate.toISOString(),
            ruleSearch: { id: ruleId }
        };

        if (deviceId && deviceId !== "__ALL__") {
            search.deviceSearch = { id: deviceId };
        }

        api.call("Get", {
            typeName: "ExceptionEvent",
            search: search,
            resultsLimit: RESULTS_LIMIT
        }, function (results) {
            // Filter to undismissed only
            var undismissed = results.filter(function (ex) {
                return ex.state !== "ExceptionEventStateDismissedId";
            });

            foundExceptions = undismissed;

            if (results.length >= RESULTS_LIMIT) {
                log("Warning: Result limit of " + RESULTS_LIMIT + " reached. There may be more exceptions.", "warn");
            }

            if (undismissed.length === 0) {
                if (results.length === 0) {
                    log("No exceptions found for the selected criteria.", "info");
                    showStatus("No exceptions found.");
                } else {
                    log("Found " + results.length + " exceptions, but all are already dismissed.", "info");
                    showStatus("All " + results.length + " exceptions are already dismissed.");
                }
            } else {
                log("Found " + undismissed.length + " undismissed exceptions (out of " + results.length + " total).", "success");
                showStatus(undismissed.length + " undismissed exceptions ready to dismiss.");
                elBtnDismiss.disabled = false;
            }

            elBtnFind.disabled = false;
            elBtnFind.textContent = "Find Exceptions";
        }, function (err) {
            log("Error fetching exceptions: " + (err.message || err), "error");
            showError("Failed to fetch exceptions. Check the log for details.");
            elBtnFind.disabled = false;
            elBtnFind.textContent = "Find Exceptions";
        });
    }

    // ── Dismiss Exceptions ──

    function dismissAll() {
        if (foundExceptions.length === 0) {
            return;
        }

        hideError();
        elBtnDismiss.disabled = true;
        elBtnFind.disabled = true;
        elBtnDismiss.textContent = "Dismissing...";

        var total = foundExceptions.length;
        log("Starting dismissal of " + total + " exceptions in batches of " + BATCH_SIZE + "...");

        processBatch(0);
    }

    function startCountdown(durationMs, dismissed, total, callback) {
        var remaining = Math.ceil(durationMs / 1000);
        var countdownInterval = setInterval(function () {
            remaining--;
            if (remaining > 0) {
                showStatus("Progress: " + dismissed + "/" + total + " — next batch in " + remaining + "s");
            } else {
                clearInterval(countdownInterval);
                showStatus("Progress: " + dismissed + "/" + total + " — sending next batch...");
                callback();
            }
        }, 1000);
    }

    function processBatch(offset) {
        var total = foundExceptions.length;

        if (offset >= total) {
            log("Successfully dismissed all " + total + " exceptions!", "success");
            showStatus("Done! " + total + " exceptions dismissed.");
            elBtnDismiss.textContent = "Dismiss All";
            elBtnFind.disabled = false;
            foundExceptions = [];
            return;
        }

        var batch = foundExceptions.slice(offset, offset + BATCH_SIZE);
        var calls = batch.map(function (ex) {
            return ["Set", {
                typeName: "ExceptionEvent",
                entity: {
                    id: ex.id,
                    state: "ExceptionEventStateDismissedId"
                }
            }];
        });

        api.multiCall(calls, function () {
            var dismissed = Math.min(offset + BATCH_SIZE, total);
            log("Dismissed " + dismissed + "/" + total + "...", "success");

            var pct = Math.round((dismissed / total) * 100);
            showStatus("Progress: " + dismissed + "/" + total + " (" + pct + "%)");

            var nextOffset = offset + BATCH_SIZE;
            if (nextOffset >= total) {
                // All done — no need to wait
                processBatch(nextOffset);
            } else {
                // Wait for rate limit to reset before next batch
                log("Waiting 60s for API rate limit to reset...", "warn");
                startCountdown(RATE_LIMIT_PAUSE_MS, dismissed, total, function () {
                    processBatch(nextOffset);
                });
            }
        }, function (err) {
            var dismissed = offset;
            log("Error at batch starting at " + offset + ": " + (err.message || err), "error");
            log("Dismissed " + dismissed + " of " + total + " before error.", "error");
            showError("Dismissal stopped due to error. " + dismissed + "/" + total + " were dismissed.");
            elBtnDismiss.textContent = "Dismiss All";
            elBtnFind.disabled = false;
        });
    }

    // ── Add-In Lifecycle ──

    return {
        initialize: function (freshApi, state, callback) {
            // Cache DOM references
            elContainer = document.getElementById("bed-container");
            elRuleSearch = document.getElementById("bed-rule-search");
            elRuleSelect = document.getElementById("bed-rule-select");
            elDeviceSearch = document.getElementById("bed-device-search");
            elDeviceSelect = document.getElementById("bed-device-select");
            elStartDate = document.getElementById("bed-start-date");
            elBtnFind = document.getElementById("bed-btn-find");
            elBtnDismiss = document.getElementById("bed-btn-dismiss");
            elStatusLine = document.getElementById("bed-status-line");
            elErrorBox = document.getElementById("bed-error-box");
            elLogArea = document.getElementById("bed-log-area");

            // Wire event listeners
            elRuleSearch.addEventListener("input", filterRules);
            elDeviceSearch.addEventListener("input", filterDevices);
            elBtnFind.addEventListener("click", findExceptions);
            elBtnDismiss.addEventListener("click", dismissAll);

            // Set date constraints
            setDateConstraints();

            callback();
        },

        focus: function (freshApi, state) {
            api = freshApi;

            // Reset state
            clearLog();
            hideStatus();
            hideError();
            foundExceptions = [];
            elBtnDismiss.disabled = true;
            elBtnFind.disabled = false;
            elBtnFind.textContent = "Find Exceptions";
            elBtnDismiss.textContent = "Dismiss All";
            elRuleSearch.value = "";
            elDeviceSearch.value = "";
            setDateConstraints();

            // Load data
            loadData();
        },

        blur: function () {
            elContainer.style.display = "none";
            allRules = [];
            allDevices = [];
            foundExceptions = [];
            clearLog();
            hideStatus();
            hideError();
        }
    };
};
