/**
 * BulkExceptionDismiss — React + Zenith MyGeotab Add-In
 *
 * Replicates the vanilla JS add-in with proper React state management
 * and Zenith design system components for native MyGeotab look-and-feel.
 *
 * Zenith API references verified against @geotab/zenith v1.26.6 .d.ts files.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Zenith imports (verified against installed @geotab/zenith v1.26.6) ──
import {
    Button,
    ButtonType,        // { Primary, Secondary, Destructive, Tertiary, ... }
    Banner,            // { type: "error"|"info"|"success"|"warning", children, header?, onClose? }
    DateInput,         // { value, onChange, disabled? }
    Select,            // { title, items: [{id,name}], value: id, onChange(id), placeholder?, disabled? }
    ProgressBar,       // { min?, max?, now?, size? }
    PageHeader,        // { title }
} from "@geotab/zenith";
// NOTE: Do NOT import @geotab/zenith/dist/index.css here.
// MyGeotab already loads Zenith CSS globally — bundling a second copy
// causes specificity conflicts (e.g. white text on white dropdowns).

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

// ══════════════════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════════════════

const BulkExceptionDismiss = ({ geotabApi }) => {
    // ── Data state ──
    // Select items use Zenith's { id: string, name: string } format
    const [ruleItems, setRuleItems] = useState([]);
    const [deviceItems, setDeviceItems] = useState([
        { id: ALL_DEVICES_ID, name: "All Devices" },
    ]);
    const [dataLoading, setDataLoading] = useState(true);

    // ── Form state ──
    // Select value is the selected item's id string
    const [selectedRuleId, setSelectedRuleId] = useState(undefined);
    const [selectedDeviceId, setSelectedDeviceId] = useState(ALL_DEVICES_ID);
    const [startDate, setStartDate] = useState(() => {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        return d;
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
    const cancelledRef = useRef(false);

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

                // Zenith Select expects { id: string, name: string }
                const rules = rawRules
                    .map((r) => ({ id: r.id, name: r.name || r.id }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                const devices = rawDevices
                    .map((d) => ({ id: d.id, name: d.name || d.id }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                setRuleItems(rules);
                setDeviceItems([
                    { id: ALL_DEVICES_ID, name: "All Devices" },
                    ...devices,
                ]);
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

    // ── Lookup helpers ──
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

        const fromDate = new Date(startDate);
        fromDate.setHours(0, 0, 0, 0);
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
                addLog(
                    `Found ${undismissed.length} undismissed exceptions (out of ${results.length} total).`,
                    "success"
                );
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
        cancelledRef.current = false;

        const total = foundExceptions.length;
        setDismissProgress({ done: 0, total });
        addLog(`Starting dismissal of ${total} exceptions in batches of ${BATCH_SIZE}...`);

        let offset = 0;

        while (offset < total) {
            if (cancelledRef.current) break;

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

            // Rate-limit pause if more batches remain
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

    // Cleanup countdown interval on unmount
    useEffect(() => {
        return () => {
            if (countdownRef.current) clearInterval(countdownRef.current);
        };
    }, []);

    // ── Derived state ──
    const canDismiss = foundExceptions.length > 0 && !dismissing && !searching;
    const canSearch = !searching && !dismissing && !dataLoading;

    // ══════════════════════════════════════════════════════════
    // Render
    // ══════════════════════════════════════════════════════════

    return (
        <div className="bed-container">
            <PageHeader title="Bulk Exception Dismiss" />

            <div className="bed-layout">
                {/* ── Left Column: Controls ── */}
                <div className="bed-controls-panel">

                    {/* Rule Select — Zenith Select: items=[{id,name}], value=id, onChange(id) */}
                    <div className="bed-form-group">
                        <Select
                            title="Rule *"
                            items={ruleItems}
                            value={selectedRuleId}
                            onChange={(id) => setSelectedRuleId(id)}
                            placeholder="Search rules..."
                            disabled={dismissing || dataLoading}
                        />
                    </div>

                    {/* Device Select */}
                    <div className="bed-form-group">
                        <Select
                            title="Device"
                            items={deviceItems}
                            value={selectedDeviceId}
                            onChange={(id) => setSelectedDeviceId(id || ALL_DEVICES_ID)}
                            placeholder="Search devices..."
                            disabled={dismissing || dataLoading}
                        />
                    </div>

                    {/* Date Input */}
                    <div className="bed-form-group">
                        <label className="bed-label">
                            Start Date <span className="bed-required">*</span>
                        </label>
                        <DateInput
                            value={startDate}
                            onChange={(date) => setStartDate(date)}
                            disabled={dismissing}
                        />
                    </div>

                    {/* Action Buttons — ButtonType enum: Primary, Destructive */}
                    <div className="bed-form-group">
                        <Button
                            type={ButtonType.Primary}
                            onClick={handleFind}
                            disabled={!canSearch}
                            className="bed-btn-full"
                        >
                            {searching ? "Searching..." : "Find Exceptions"}
                        </Button>
                    </div>

                    <div className="bed-form-group">
                        <Button
                            type={ButtonType.Destructive}
                            onClick={handleDismiss}
                            disabled={!canDismiss}
                            className="bed-btn-full"
                        >
                            {dismissing ? "Dismissing..." : "Dismiss All"}
                        </Button>
                    </div>

                    {/* Progress Bar — Zenith: min, max, now (not "value") */}
                    {dismissing && dismissProgress.total > 0 && (
                        <div className="bed-form-group">
                            <ProgressBar
                                min={0}
                                max={dismissProgress.total}
                                now={dismissProgress.done}
                            />
                        </div>
                    )}

                    {/* Status Banner */}
                    {statusMessage && (
                        <Banner type="info">
                            {statusMessage}
                        </Banner>
                    )}

                    {/* Error Banner */}
                    {errorMessage && (
                        <Banner type="error" onClose={() => setErrorMessage("")}>
                            {errorMessage}
                        </Banner>
                    )}
                </div>

                {/* ── Right Column: Log ── */}
                <div className="bed-log-panel">
                    <div className="bed-log-header">
                        <label className="bed-label">
                            Progress Log
                            {logs.length > 0 && (
                                <span className="bed-log-count"> ({logs.length} entries)</span>
                            )}
                        </label>
                        {logs.length > 0 && (
                            <button
                                className="bed-log-clear"
                                onClick={() => setLogs([])}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="bed-log-area">
                        {logs.length === 0 ? (
                            <div className="bed-log-empty">
                                No activity yet. Select a rule and click "Find Exceptions" to begin.
                            </div>
                        ) : (
                            logs.map((entry, i) => (
                                <div key={i} className={`bed-log-entry bed-log-entry--${entry.type}`}>
                                    <span className="bed-log-icon" />
                                    <span className="bed-log-time">{entry.time}</span>
                                    <span className="bed-log-message">{entry.message}</span>
                                </div>
                            ))
                        )}
                        <div ref={logEndRef} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BulkExceptionDismiss;
