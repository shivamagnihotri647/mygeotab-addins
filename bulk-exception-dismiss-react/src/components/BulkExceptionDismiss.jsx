/**
 * BulkExceptionDismiss — React + Zenith MyGeotab Add-In
 *
 * Replicates the vanilla JS add-in with proper React state management
 * and Zenith design system components for native MyGeotab look-and-feel.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Zenith imports (verified against actual @geotab/zenith package exports) ──
import {
    Button,
    ButtonType,
    Banner,
    DateInput,
    Select,
    ProgressBar,
    SearchInput,
    PageHeader,
    PageHeaderDisplayName,
} from "@geotab/zenith";
import "@geotab/zenith/dist/index.css";

// ── Constants ──
const BATCH_SIZE = 100;
const RESULTS_LIMIT = 50_000;
const RATE_LIMIT_PAUSE_MS = 61_000;

// All Devices sentinel
const ALL_DEVICES_OPTION = { id: "__ALL__", label: "All Devices" };

// ── Helper: wrap legacy api.call in a Promise ──
const apiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.call(method, params, resolve, reject);
    });

const apiMultiCall = (api, calls) =>
    new Promise((resolve, reject) => {
        api.multiCall(calls, resolve, reject);
    });

// ── Helper: timestamp for log lines ──
const timestamp = () => new Date().toLocaleTimeString();

// ══════════════════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════════════════

const BulkExceptionDismiss = ({ geotabApi }) => {
    // ── Data state ──
    const [allRules, setAllRules] = useState([]);
    const [allDevices, setAllDevices] = useState([]);
    const [dataLoading, setDataLoading] = useState(true);

    // ── Form state ──
    const [selectedRule, setSelectedRule] = useState(null);
    const [selectedDevice, setSelectedDevice] = useState(ALL_DEVICES_OPTION);
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
    const [countdown, setCountdown] = useState(0);
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

                const rules = rawRules
                    .map((r) => ({ id: r.id, label: r.name || r.id }))
                    .sort((a, b) => a.label.localeCompare(b.label));

                const devices = rawDevices
                    .map((d) => ({ id: d.id, label: d.name || d.id }))
                    .sort((a, b) => a.label.localeCompare(b.label));

                setAllRules(rules);
                setAllDevices(devices);
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

    // ── Find Exceptions ──
    const handleFind = useCallback(async () => {
        setErrorMessage("");
        setStatusMessage("");
        setFoundExceptions([]);

        if (!selectedRule) {
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

        const deviceLabel = selectedDevice?.id === "__ALL__" ? "All Devices" : selectedDevice?.label || "All Devices";

        addLog(`Searching exceptions for rule: ${selectedRule.label}`);
        addLog(`Device: ${deviceLabel}`);
        addLog(`Date range: ${fromDate.toLocaleDateString()} to ${toDate.toLocaleDateString()}`);

        setSearching(true);

        const search = {
            fromDate: fromDate.toISOString(),
            toDate: toDate.toISOString(),
            ruleSearch: { id: selectedRule.id },
        };

        if (selectedDevice && selectedDevice.id !== "__ALL__") {
            search.deviceSearch = { id: selectedDevice.id };
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
    }, [geotabApi, selectedRule, selectedDevice, startDate, addLog]);

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
                    setCountdown(remaining);

                    countdownRef.current = setInterval(() => {
                        remaining -= 1;
                        setCountdown(remaining);
                        setStatusMessage(
                            `Progress: ${dismissed}/${total} — next batch in ${remaining}s`
                        );

                        if (remaining <= 0) {
                            clearInterval(countdownRef.current);
                            countdownRef.current = null;
                            setCountdown(0);
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
    const progressPct =
        dismissProgress.total > 0
            ? Math.round((dismissProgress.done / dismissProgress.total) * 100)
            : 0;

    // ── Device options with "All Devices" prepended ──
    const deviceOptions = [ALL_DEVICES_OPTION, ...allDevices];

    // ══════════════════════════════════════════════════════════
    // Render
    // ══════════════════════════════════════════════════════════

    return (
        <div className="bed-container">
            {/* ── Page Header ── */}
            <PageHeader title="Bulk Exception Dismiss" />

            <div className="bed-layout">
                {/* ── Left Column: Controls ── */}
                <div className="bed-controls-panel">

                    {/* Rule Select */}
                    <div className="bed-form-group">
                        <label className="bed-label">
                            Rule <span className="bed-required">*</span>
                        </label>
                        <Select
                            options={allRules.map((r) => ({ label: r.label, value: r.id }))}
                            value={selectedRule ? { label: selectedRule.label, value: selectedRule.id } : null}
                            onChange={(option) => setSelectedRule(option ? { id: option.value, label: option.label } : null)}
                            placeholder="Search rules..."
                            isSearchable
                            isLoading={dataLoading}
                            isDisabled={dismissing}
                        />
                    </div>

                    {/* Device Select */}
                    <div className="bed-form-group">
                        <label className="bed-label">Device</label>
                        <Select
                            options={deviceOptions.map((d) => ({ label: d.label, value: d.id }))}
                            value={{ label: selectedDevice.label, value: selectedDevice.id }}
                            onChange={(option) => {
                                if (option) {
                                    setSelectedDevice({ id: option.value, label: option.label });
                                } else {
                                    setSelectedDevice(ALL_DEVICES_OPTION);
                                }
                            }}
                            placeholder="Search devices..."
                            isSearchable
                            isLoading={dataLoading}
                            isDisabled={dismissing}
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
                            maxDate={new Date()}
                            disabled={dismissing}
                        />
                    </div>

                    {/* Action Buttons */}
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
                            type={ButtonType.Danger}
                            onClick={handleDismiss}
                            disabled={!canDismiss}
                            className="bed-btn-full"
                        >
                            {dismissing ? "Dismissing..." : "Dismiss All"}
                        </Button>
                    </div>

                    {/* Progress Bar (visible during dismissal) */}
                    {dismissing && (
                        <div className="bed-form-group">
                            <ProgressBar value={progressPct} />
                        </div>
                    )}

                    {/* Status Banner */}
                    {statusMessage && (
                        <Banner type="info" className="bed-form-group">
                            {statusMessage}
                        </Banner>
                    )}

                    {/* Error Banner */}
                    {errorMessage && (
                        <Banner type="error" className="bed-form-group">
                            {errorMessage}
                        </Banner>
                    )}
                </div>

                {/* ── Right Column: Log ── */}
                <div className="bed-log-panel">
                    <label className="bed-label">Progress Log</label>
                    <div className="bed-log-area">
                        {logs.map((entry, i) => (
                            <div key={i} className={`bed-log-${entry.type}`}>
                                [{entry.time}] {entry.message}
                            </div>
                        ))}
                        <div ref={logEndRef} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BulkExceptionDismiss;
