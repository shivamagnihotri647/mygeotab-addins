/**
 * BulkExceptionDismiss — React MyGeotab Add-In
 *
 * Uses React for state management with standard HTML elements styled
 * by MyGeotab's built-in CSS classes. Avoids bundling @geotab/zenith
 * components which cause version/CSS conflicts when loaded inside MyGeotab.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ── Constants ──
const BATCH_SIZE = 100;
const RESULTS_LIMIT = 50_000;
const RATE_LIMIT_PAUSE_MS = 61_000;
const ALL_DEVICES_ID = "__ALL__";

// ── Helper: wrap legacy api.call in a Promise ──
const apiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.call(method, params, resolve, reject);
    });

const apiMultiCall = (api, calls) =>
    new Promise((resolve, reject) => {
        api.multiCall(calls, resolve, reject);
    });

const timestamp = () => new Date().toLocaleTimeString();

// ── Sub-components ──

const SearchableSelect = ({ label, required, items, value, onChange, placeholder, disabled }) => {
    const [search, setSearch] = useState("");

    const filtered = useMemo(() => {
        if (!search) return items;
        const term = search.toLowerCase();
        return items.filter((item) => item.name.toLowerCase().includes(term));
    }, [items, search]);

    return (
        <div className="bed-form-group">
            {label && (
                <label className="bed-label">
                    {label} {required && <span className="bed-required">*</span>}
                </label>
            )}
            <input
                type="text"
                className="bed-search-input"
                placeholder={placeholder || "Type to search..."}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={disabled}
            />
            <select
                className="bed-select"
                size="6"
                value={value || ""}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
            >
                {filtered.length === 0 ? (
                    <option value="" disabled>No results found</option>
                ) : (
                    filtered.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))
                )}
            </select>
        </div>
    );
};

const LogEntry = ({ entry }) => (
    <div className={`bed-log-entry bed-log-entry--${entry.type}`}>
        <span className="bed-log-dot" />
        <span className="bed-log-time">{entry.time}</span>
        <span className="bed-log-message">{entry.message}</span>
    </div>
);

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

const BulkExceptionDismiss = ({ geotabApi }) => {
    // ── Data state ──
    const [ruleItems, setRuleItems] = useState([]);
    const [deviceItems, setDeviceItems] = useState([
        { id: ALL_DEVICES_ID, name: "All Devices" },
    ]);
    const [dataLoading, setDataLoading] = useState(true);

    // ── Form state ──
    const [selectedRuleId, setSelectedRuleId] = useState("");
    const [selectedDeviceId, setSelectedDeviceId] = useState(ALL_DEVICES_ID);
    const [startDate, setStartDate] = useState(() => {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        return d.toISOString().split("T")[0];
    });

    // ── Exception / dismiss state ──
    const [foundExceptions, setFoundExceptions] = useState([]);
    const [searching, setSearching] = useState(false);
    const [dismissing, setDismissing] = useState(false);

    // ── Feedback state ──
    const [statusMessage, setStatusMessage] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [logs, setLogs] = useState([]);
    const [dismissProgress, setDismissProgress] = useState({ done: 0, total: 0 });

    // ── Refs ──
    const logEndRef = useRef(null);
    const countdownRef = useRef(null);

    // ── Log helper ──
    const addLog = useCallback((message, type = "info") => {
        setLogs((prev) => [...prev, { time: timestamp(), message, type }]);
    }, []);

    // Auto-scroll log area
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    // ── Load rules & devices on mount ──
    useEffect(() => {
        if (!geotabApi) return;
        let cancelled = false;

        const load = async () => {
            addLog("Loading rules and devices...");
            try {
                const [rawRules, rawDevices] = await Promise.all([
                    apiCall(geotabApi, "Get", { typeName: "Rule", resultsLimit: RESULTS_LIMIT }),
                    apiCall(geotabApi, "Get", { typeName: "Device", resultsLimit: RESULTS_LIMIT }),
                ]);
                if (cancelled) return;

                const rules = rawRules
                    .map((r) => ({ id: r.id, name: r.name || r.id }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                const devices = rawDevices
                    .map((d) => ({ id: d.id, name: d.name || d.id }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                setRuleItems(rules);
                setDeviceItems([{ id: ALL_DEVICES_ID, name: "All Devices" }, ...devices]);
                addLog(`Loaded ${rules.length} rules and ${devices.length} devices.`, "success");
            } catch (err) {
                if (!cancelled) {
                    addLog(`Failed to load data: ${err.message || err}`, "error");
                    setErrorMessage("Failed to load rules and devices. Please refresh the page.");
                }
            } finally {
                if (!cancelled) setDataLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [geotabApi, addLog]);

    // ── Lookup helper ──
    const getItemName = useCallback((items, id) => {
        const item = items.find((i) => i.id === id);
        return item ? item.name : id || "Unknown";
    }, []);

    // ── Find Exceptions ──
    const handleFind = useCallback(async () => {
        setErrorMessage("");
        setStatusMessage("");
        setFoundExceptions([]);

        if (!selectedRuleId) {
            setErrorMessage("Please select a rule.");
            return;
        }
        if (!startDate) {
            setErrorMessage("Please select a start date.");
            return;
        }

        const fromDate = new Date(startDate + "T00:00:00");
        const toDate = new Date();
        const ruleName = getItemName(ruleItems, selectedRuleId);
        const deviceName = selectedDeviceId === ALL_DEVICES_ID
            ? "All Devices"
            : getItemName(deviceItems, selectedDeviceId);

        addLog(`Searching exceptions for rule: ${ruleName}`);
        addLog(`Device: ${deviceName}`);
        addLog(`Date range: ${fromDate.toLocaleDateString()} to ${toDate.toLocaleDateString()}`);
        setSearching(true);

        const search = {
            fromDate: fromDate.toISOString(),
            toDate: toDate.toISOString(),
            ruleSearch: { id: selectedRuleId },
        };

        if (selectedDeviceId && selectedDeviceId !== ALL_DEVICES_ID) {
            search.deviceSearch = { id: selectedDeviceId };
        }

        try {
            const results = await apiCall(geotabApi, "Get", {
                typeName: "ExceptionEvent",
                search,
                resultsLimit: RESULTS_LIMIT,
            });

            if (results.length >= RESULTS_LIMIT) {
                addLog(`Warning: Result limit of ${RESULTS_LIMIT} reached. There may be more exceptions.`, "warn");
            }

            const undismissed = results.filter(
                (ex) => ex.state !== "ExceptionEventStateDismissedId"
            );
            setFoundExceptions(undismissed);

            if (undismissed.length === 0) {
                if (results.length === 0) {
                    addLog("No exceptions found for the selected criteria.");
                    setStatusMessage("No exceptions found.");
                } else {
                    addLog(`Found ${results.length} exceptions, but all are already dismissed.`);
                    setStatusMessage(`All ${results.length} exceptions are already dismissed.`);
                }
            } else {
                addLog(`Found ${undismissed.length} undismissed exceptions (out of ${results.length} total).`, "success");
                setStatusMessage(`${undismissed.length} undismissed exceptions ready to dismiss.`);
            }
        } catch (err) {
            addLog(`Error fetching exceptions: ${err.message || err}`, "error");
            setErrorMessage("Failed to fetch exceptions. Check the log for details.");
        } finally {
            setSearching(false);
        }
    }, [geotabApi, selectedRuleId, selectedDeviceId, startDate, ruleItems, deviceItems, getItemName, addLog]);

    // ── Dismiss All ──
    const handleDismiss = useCallback(async () => {
        if (foundExceptions.length === 0) return;

        setErrorMessage("");
        setDismissing(true);

        const total = foundExceptions.length;
        setDismissProgress({ done: 0, total });
        addLog(`Starting dismissal of ${total} exceptions in batches of ${BATCH_SIZE}...`);

        let offset = 0;

        while (offset < total) {
            const batch = foundExceptions.slice(offset, offset + BATCH_SIZE);
            const calls = batch.map((ex) => [
                "Set",
                {
                    typeName: "ExceptionEvent",
                    entity: { id: ex.id, state: "ExceptionEventStateDismissedId" },
                },
            ]);

            try {
                await apiMultiCall(geotabApi, calls);
            } catch (err) {
                addLog(`Error at batch starting at ${offset}: ${err.message || err}`, "error");
                addLog(`Dismissed ${offset} of ${total} before error.`, "error");
                setErrorMessage(`Dismissal stopped due to error. ${offset}/${total} were dismissed.`);
                setDismissing(false);
                return;
            }

            const dismissed = Math.min(offset + BATCH_SIZE, total);
            addLog(`Dismissed ${dismissed}/${total}...`, "success");
            setDismissProgress({ done: dismissed, total });

            const pct = Math.round((dismissed / total) * 100);
            setStatusMessage(`Progress: ${dismissed}/${total} (${pct}%)`);

            offset += BATCH_SIZE;

            if (offset < total) {
                addLog("Waiting 60s for API rate limit to reset...", "warn");

                await new Promise((resolve) => {
                    let remaining = Math.ceil(RATE_LIMIT_PAUSE_MS / 1000);

                    countdownRef.current = setInterval(() => {
                        remaining -= 1;
                        setStatusMessage(
                            `Progress: ${dismissed}/${total} — next batch in ${remaining}s`
                        );
                        if (remaining <= 0) {
                            clearInterval(countdownRef.current);
                            countdownRef.current = null;
                            setStatusMessage(`Progress: ${dismissed}/${total} — sending next batch...`);
                            resolve();
                        }
                    }, 1000);
                });
            }
        }

        addLog(`Successfully dismissed all ${total} exceptions!`, "success");
        setStatusMessage(`Done! ${total} exceptions dismissed.`);
        setFoundExceptions([]);
        setDismissProgress({ done: 0, total: 0 });
        setDismissing(false);
    }, [geotabApi, foundExceptions, addLog]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (countdownRef.current) clearInterval(countdownRef.current);
        };
    }, []);

    // ── Derived state ──
    const canDismiss = foundExceptions.length > 0 && !dismissing && !searching;
    const canSearch = !searching && !dismissing && !dataLoading;
    const today = new Date().toISOString().split("T")[0];
    const progressPct = dismissProgress.total > 0
        ? Math.round((dismissProgress.done / dismissProgress.total) * 100)
        : 0;

    // ══════════════════════════════════════════════════════════
    // Render
    // ══════════════════════════════════════════════════════════

    return (
        <div className="bed-container">
            <div className="geotabPageHeader">
                <h1 className="geotabPageName">Bulk Exception Dismiss</h1>
            </div>

            <div className="bed-layout">
                {/* ── Left Column: Controls ── */}
                <div className="bed-controls-panel">

                    <SearchableSelect
                        label="Rule"
                        required
                        items={ruleItems}
                        value={selectedRuleId}
                        onChange={setSelectedRuleId}
                        placeholder="Search rules..."
                        disabled={dismissing || dataLoading}
                    />

                    <SearchableSelect
                        label="Device"
                        items={deviceItems}
                        value={selectedDeviceId}
                        onChange={(id) => setSelectedDeviceId(id || ALL_DEVICES_ID)}
                        placeholder="Search devices..."
                        disabled={dismissing || dataLoading}
                    />

                    <div className="bed-form-group">
                        <label className="bed-label">
                            Start Date <span className="bed-required">*</span>
                        </label>
                        <input
                            type="date"
                            className="bed-date-input"
                            value={startDate}
                            max={today}
                            onChange={(e) => setStartDate(e.target.value)}
                            disabled={dismissing}
                        />
                    </div>

                    <div className="bed-form-group">
                        <button
                            className="geotabButton bed-btn-full"
                            onClick={handleFind}
                            disabled={!canSearch}
                        >
                            {searching ? "Searching..." : "Find Exceptions"}
                        </button>
                    </div>

                    <div className="bed-form-group">
                        <button
                            className="geotabButton bed-btn-danger bed-btn-full"
                            onClick={handleDismiss}
                            disabled={!canDismiss}
                        >
                            {dismissing ? "Dismissing..." : "Dismiss All"}
                        </button>
                    </div>

                    {/* Progress bar */}
                    {dismissing && dismissProgress.total > 0 && (
                        <div className="bed-form-group">
                            <div className="bed-progress-bar">
                                <div
                                    className="bed-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <div className="bed-progress-label">
                                {dismissProgress.done} / {dismissProgress.total} ({progressPct}%)
                            </div>
                        </div>
                    )}

                    {/* Status banner */}
                    {statusMessage && (
                        <div className="bed-banner bed-banner--info">
                            {statusMessage}
                        </div>
                    )}

                    {/* Error banner */}
                    {errorMessage && (
                        <div className="bed-banner bed-banner--error">
                            <span>{errorMessage}</span>
                            <button
                                className="bed-banner-close"
                                onClick={() => setErrorMessage("")}
                            >
                                &times;
                            </button>
                        </div>
                    )}
                </div>

                {/* ── Right Column: Log ── */}
                <div className="bed-log-panel">
                    <div className="bed-log-header">
                        <label className="bed-label">
                            Progress Log
                            {logs.length > 0 && (
                                <span className="bed-log-count"> ({logs.length})</span>
                            )}
                        </label>
                        {logs.length > 0 && (
                            <button className="bed-log-clear" onClick={() => setLogs([])}>
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="bed-log-area">
                        {logs.length === 0 ? (
                            <div className="bed-log-empty">
                                Select a rule and click "Find Exceptions" to begin.
                            </div>
                        ) : (
                            logs.map((entry, i) => <LogEntry key={i} entry={entry} />)
                        )}
                        <div ref={logEndRef} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BulkExceptionDismiss;
