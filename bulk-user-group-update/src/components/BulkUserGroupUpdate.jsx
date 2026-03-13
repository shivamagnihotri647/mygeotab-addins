/**
 * BulkUserGroupUpdate — React MyGeotab Add-In
 *
 * Bulk-updates users' companyGroups (and driverGroups for drivers)
 * from a CSV file with username and groupName columns.
 * Uses Get → mutate → Set pattern to preserve the full user entity.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";

// ── Constants ──
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 1000;
const LOOKUP_BATCH_SIZE = 50;

// ══════════════════════════════════════════════════════════════
// API Helpers
// ══════════════════════════════════════════════════════════════

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
// CSV Utilities
// ══════════════════════════════════════════════════════════════

function parseCsvLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ",") {
                result.push(current.trim());
                current = "";
            } else {
                current += ch;
            }
        }
    }
    result.push(current.trim());
    return result;
}

function parseCsvWithHeaders(text) {
    const clean = text.replace(/^\uFEFF/, "");
    const lines = clean.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 1) return { headers: [], rows: [] };

    const headers = parseCsvLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] || "";
        });
        rows.push(row);
    }

    return { headers, rows };
}

function downloadCsv(content, filename) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════
// Group Resolution
// ══════════════════════════════════════════════════════════════

/**
 * Resolve pipe-separated group names/IDs into [{id: ...}] array.
 * Tries name lookup in groupCache first, falls back to raw ID.
 */
function resolveGroups(value, groupCache) {
    if (!value) return null;
    const parts = value.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    const result = [];
    for (const part of parts) {
        if (groupCache && groupCache[part]) {
            result.push({ id: groupCache[part].id });
        } else {
            result.push({ id: part });
        }
    }
    return result.length > 0 ? result : null;
}

/** Format groups array as pipe-separated display names */
function formatGroups(groups, groupIdToName) {
    if (!groups || groups.length === 0) return "(none)";
    return groups
        .map((g) => groupIdToName[g.id] || g.id)
        .join(" | ");
}

// ══════════════════════════════════════════════════════════════
// Error Message Parsing
// ══════════════════════════════════════════════════════════════

function parseErrorMessage(error) {
    const s = String(error);
    if (s.indexOf("CompanyGroups cannot be null or empty") >= 0) return "Invalid group name";
    if (s.indexOf("CompanyGroups must be visible to User's AccessGroupFilter") >= 0) return "AccessGroupFilter mismatch — groups not visible";
    if (s.indexOf("SecurityGroups") >= 0) return "Invalid security clearance";
    if (s.indexOf("DuplicateException") >= 0) return "Duplicate entity conflict";
    return s.length > 120 ? s.substring(0, 120) + "..." : s;
}

// ══════════════════════════════════════════════════════════════
// Results CSV
// ══════════════════════════════════════════════════════════════

function generateResultsCsv(rows) {
    const cols = ["username", "groupName", "previousGroups", "status", "error"];
    const lines = [cols.join(",")];

    for (const row of rows) {
        const values = cols.map((col) => {
            const val = row[col] || "";
            if (val.includes(",") || val.includes('"')) {
                return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        });
        lines.push(values.join(","));
    }

    return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════
// Batch Delay
// ══════════════════════════════════════════════════════════════

function batchDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════
// Sub-Components
// ══════════════════════════════════════════════════════════════

function LogEntry({ type, time, message }) {
    return (
        <div className={`bugu-log-entry bugu-log-entry--${type}`}>
            <span className="bugu-log-dot" />
            <span className="bugu-log-time">{time}</span>
            <span className="bugu-log-message">{message}</span>
        </div>
    );
}

function StatusBadge({ status }) {
    return <span className={`bugu-badge bugu-badge--${status}`}>{status.replace(/-/g, " ")}</span>;
}

function PreviewTable({ rows }) {
    if (!rows || rows.length === 0) return null;

    return (
        <div className="bugu-table-wrap">
            <table className="bugu-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Username</th>
                        <th>Target Group(s)</th>
                        <th>Current Group(s)</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, idx) => (
                        <tr key={idx}>
                            <td>{idx + 1}</td>
                            <td>{row.username}</td>
                            <td>{row.groupName}</td>
                            <td title={row.currentGroups}>{row.currentGroups || "..."}</td>
                            <td>
                                <StatusBadge status={row.status} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

export default function BulkUserGroupUpdate({ geotabApi }) {
    // API data caches
    const [groupCache, setGroupCache] = useState(null);
    const [groupIdToName, setGroupIdToName] = useState({});
    const [apiDataLoaded, setApiDataLoaded] = useState(false);

    // CSV / file state
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState("");
    const [rows, setRows] = useState([]);

    // Processing state
    const [lookingUp, setLookingUp] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [progressTotal, setProgressTotal] = useState(0);
    const [completed, setCompleted] = useState(false);

    // Log state
    const [logs, setLogs] = useState([]);
    const logEndRef = useRef(null);
    const fileInputRef = useRef(null);

    // Auto-scroll log
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    const addLog = useCallback((message, type = "info") => {
        setLogs((prev) => [...prev, { message, type, time: timestamp() }]);
    }, []);

    // ── Fetch groups on mount ──
    useEffect(() => {
        if (!geotabApi) return;

        let cancelled = false;

        async function fetchData() {
            try {
                const groups = await apiCall(geotabApi, "Get", { typeName: "Group" });
                if (cancelled) return;

                const cache = {};
                const idMap = {};
                for (const g of groups) {
                    const name = g.name || g.id;
                    cache[name] = g;
                    idMap[g.id] = name;
                }
                setGroupCache(cache);
                setGroupIdToName(idMap);
                setApiDataLoaded(true);
                addLog(`Loaded ${groups.length} groups from database`, "info");
            } catch (err) {
                if (!cancelled) {
                    addLog("Failed to load groups: " + parseErrorMessage(err), "error");
                    setGroupCache({});
                    setGroupIdToName({});
                    setApiDataLoaded(true);
                }
            }
        }

        fetchData();
        return () => { cancelled = true; };
    }, [geotabApi, addLog]);

    // ── CSV Upload Handlers ──
    const processFile = useCallback(
        (file) => {
            if (!file || !file.name.endsWith(".csv")) {
                addLog("Please upload a .csv file", "error");
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                const { headers, rows: csvRows } = parseCsvWithHeaders(text);

                // Validate required columns
                const hasUsername = headers.includes("username");
                const hasGroupName = headers.includes("groupName");
                const missing = [];
                if (!hasUsername) missing.push("username");
                if (!hasGroupName) missing.push("groupName");

                if (missing.length > 0) {
                    addLog(
                        `CSV missing required columns: ${missing.join(", ")}. Expected: username, groupName`,
                        "error"
                    );
                    return;
                }

                if (csvRows.length === 0) {
                    addLog("CSV has no data rows", "error");
                    return;
                }

                const taggedRows = csvRows.map((row) => ({
                    username: row.username,
                    groupName: row.groupName,
                    currentGroups: "",
                    previousGroups: "",
                    status: "pending",
                    error: "",
                    _userEntity: null,
                }));

                setFileName(file.name);
                setRows(taggedRows);
                setCompleted(false);
                addLog(
                    `Loaded ${csvRows.length} rows from ${file.name} | Columns: ${headers.join(", ")}`,
                    "success"
                );

                // Auto-lookup users after loading
                lookupUsers(taggedRows);
            };
            reader.readAsText(file);
        },
        [addLog, geotabApi, groupCache, groupIdToName]
    );

    // ── User Lookup (batched multiCall) ──
    const lookupUsers = useCallback(
        async (inputRows) => {
            if (!geotabApi || !groupCache) return;

            setLookingUp(true);
            addLog(`Looking up ${inputRows.length} users...`, "info");

            const updated = [...inputRows];

            // Batch user lookups
            for (let i = 0; i < updated.length; i += LOOKUP_BATCH_SIZE) {
                const batch = updated.slice(i, i + LOOKUP_BATCH_SIZE);
                const calls = batch.map((row) => [
                    "Get",
                    { typeName: "User", search: { name: row.username } },
                ]);

                try {
                    const results = await apiMultiCall(geotabApi, calls);
                    for (let j = 0; j < batch.length; j++) {
                        const idx = i + j;
                        const userArr = results[j];
                        if (userArr && userArr.length > 0) {
                            const user = userArr[0];
                            updated[idx] = {
                                ...updated[idx],
                                currentGroups: formatGroups(user.companyGroups, groupIdToName),
                                previousGroups: formatGroups(user.companyGroups, groupIdToName),
                                status: "ready",
                                _userEntity: user,
                            };
                        } else {
                            updated[idx] = {
                                ...updated[idx],
                                currentGroups: "(user not found)",
                                status: "not-found",
                                error: "User not found",
                            };
                        }
                    }
                } catch (err) {
                    // Batch failed — try individually
                    addLog(`Batch lookup failed, trying individually...`, "warn");
                    for (let j = 0; j < batch.length; j++) {
                        const idx = i + j;
                        try {
                            const userArr = await apiCall(geotabApi, "Get", {
                                typeName: "User",
                                search: { name: batch[j].username },
                            });
                            if (userArr && userArr.length > 0) {
                                const user = userArr[0];
                                updated[idx] = {
                                    ...updated[idx],
                                    currentGroups: formatGroups(user.companyGroups, groupIdToName),
                                    previousGroups: formatGroups(user.companyGroups, groupIdToName),
                                    status: "ready",
                                    _userEntity: user,
                                };
                            } else {
                                updated[idx] = {
                                    ...updated[idx],
                                    currentGroups: "(user not found)",
                                    status: "not-found",
                                    error: "User not found",
                                };
                            }
                        } catch (singleErr) {
                            updated[idx] = {
                                ...updated[idx],
                                currentGroups: "(lookup failed)",
                                status: "failed",
                                error: parseErrorMessage(singleErr),
                            };
                        }
                    }
                }
            }

            setRows(updated);

            const found = updated.filter((r) => r.status === "ready").length;
            const notFound = updated.filter((r) => r.status === "not-found").length;
            const failed = updated.filter((r) => r.status === "failed").length;

            let msg = `Lookup complete: ${found} found`;
            if (notFound > 0) msg += `, ${notFound} not found`;
            if (failed > 0) msg += `, ${failed} errors`;
            addLog(msg, notFound > 0 || failed > 0 ? "warn" : "success");

            setLookingUp(false);
        },
        [geotabApi, groupCache, groupIdToName, addLog]
    );

    const handleDrop = useCallback(
        (e) => {
            e.preventDefault();
            setDragOver(false);
            if (processing || lookingUp) return;
            const file = e.dataTransfer.files[0];
            processFile(file);
        },
        [processing, lookingUp, processFile]
    );

    const handleDragOver = useCallback(
        (e) => {
            e.preventDefault();
            if (!processing && !lookingUp) setDragOver(true);
        },
        [processing, lookingUp]
    );

    const handleDragLeave = useCallback(() => setDragOver(false), []);

    const handleBrowse = useCallback(() => {
        if (!processing && !lookingUp) fileInputRef.current?.click();
    }, [processing, lookingUp]);

    const handleFileChange = useCallback(
        (e) => {
            const file = e.target.files[0];
            if (file) processFile(file);
            e.target.value = "";
        },
        [processFile]
    );

    const handleClearFile = useCallback(() => {
        setFileName("");
        setRows([]);
        setCompleted(false);
    }, []);

    // ── Update Groups Handler ──
    const handleUpdate = useCallback(async () => {
        if (!geotabApi || rows.length === 0) return;

        const updatable = rows.filter((r) => r.status === "ready");
        if (updatable.length === 0) {
            addLog("No users with 'ready' status to update", "warn");
            return;
        }

        setProcessing(true);
        setProgress(0);
        setProgressTotal(updatable.length);
        setCompleted(false);

        addLog(`Starting group update for ${updatable.length} users...`, "info");

        // Mark updatable rows as "updating"
        setRows((prev) =>
            prev.map((r) => (r.status === "ready" ? { ...r, status: "updating" } : r))
        );

        // Build Set calls
        const setCalls = [];
        const rowIndices = []; // maps setCalls index → rows index

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.status !== "ready" && row.status !== "updating") continue;
            if (!row._userEntity) continue;

            const newGroups = resolveGroups(row.groupName, groupCache);
            if (!newGroups) {
                setRows((prev) => {
                    const u = [...prev];
                    u[i] = { ...u[i], status: "failed", error: "Could not resolve group name(s)" };
                    return u;
                });
                continue;
            }

            // Clone user entity and update groups
            const user = { ...row._userEntity };

            // Debug: log existing accessGroupFilter structure for first user
            if (setCalls.length === 0) {
                console.log("[BUGU DEBUG] Existing user entity keys:", Object.keys(user));
                console.log("[BUGU DEBUG] Existing accessGroupFilter:", JSON.stringify(user.accessGroupFilter, null, 2));
                console.log("[BUGU DEBUG] Existing companyGroups:", JSON.stringify(user.companyGroups, null, 2));
                console.log("[BUGU DEBUG] Target newGroups:", JSON.stringify(newGroups, null, 2));
            }

            user.companyGroups = newGroups;

            // Sync accessGroupFilter to match companyGroups
            // (MyGeotab requires all companyGroups to be visible in the user's accessGroupFilter)
            // Leaf node uses `groupId` (string), branch node uses `groupFilterConditions` array with `relation`
            if (newGroups.length === 1) {
                user.accessGroupFilter = {
                    groupFilterCondition: { groupId: newGroups[0].id }
                };
            } else {
                user.accessGroupFilter = {
                    groupFilterCondition: {
                        groupFilterConditions: newGroups.map(g => ({ groupId: g.id })),
                        relation: "Or"
                    }
                };
            }

            // Debug: log what we're sending
            if (setCalls.length === 0) {
                console.log("[BUGU DEBUG] New accessGroupFilter:", JSON.stringify(user.accessGroupFilter, null, 2));
                console.log("[BUGU DEBUG] Full entity being sent:", JSON.stringify(user, null, 2));
            }

            // Sync driverGroups if user is a driver
            if (user.isDriver) {
                user.driverGroups = newGroups;
            }

            setCalls.push(["Set", { typeName: "User", entity: user }]);
            rowIndices.push(i);
        }

        if (setCalls.length === 0) {
            addLog("No valid Set calls to execute", "warn");
            setProcessing(false);
            return;
        }

        // Batched execution
        let successCount = 0;
        let failCount = 0;
        const totalBatches = Math.ceil(setCalls.length / BATCH_SIZE);

        for (let i = 0; i < setCalls.length; i += BATCH_SIZE) {
            const batch = setCalls.slice(i, i + BATCH_SIZE);
            const batchIndices = rowIndices.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;

            if (totalBatches > 1) {
                addLog(`Batch ${batchNum}/${totalBatches} (${batch.length} users)...`, "info");
            }

            try {
                await apiMultiCall(geotabApi, batch);
                // All succeeded
                for (let j = 0; j < batch.length; j++) {
                    const rowIdx = batchIndices[j];
                    setRows((prev) => {
                        const u = [...prev];
                        u[rowIdx] = { ...u[rowIdx], status: "success", error: "" };
                        return u;
                    });
                    successCount++;
                }
            } catch (err) {
                addLog(`Batch ${batchNum} failed, processing individually...`, "warn");
                for (let j = 0; j < batch.length; j++) {
                    const rowIdx = batchIndices[j];
                    try {
                        await apiCall(geotabApi, "Set", batch[j][1]);
                        setRows((prev) => {
                            const u = [...prev];
                            u[rowIdx] = { ...u[rowIdx], status: "success", error: "" };
                            return u;
                        });
                        successCount++;
                    } catch (singleErr) {
                        const errMsg = parseErrorMessage(singleErr);
                        setRows((prev) => {
                            const u = [...prev];
                            u[rowIdx] = { ...u[rowIdx], status: "failed", error: errMsg };
                            return u;
                        });
                        failCount++;
                        addLog(`Failed: ${rows[rowIdx].username} — ${errMsg}`, "error");
                    }
                }
            }

            setProgress(Math.min(i + batch.length, setCalls.length));

            // Delay before next batch
            if (i + BATCH_SIZE < setCalls.length) {
                await batchDelay(BATCH_DELAY_MS);
            }
        }

        addLog(
            `Update complete: ${successCount} succeeded, ${failCount} failed out of ${setCalls.length} total`,
            failCount > 0 ? "warn" : "success"
        );

        setProcessing(false);
        setCompleted(true);
    }, [geotabApi, rows, groupCache, addLog]);

    // ── Download Results ──
    const handleDownloadResults = useCallback(() => {
        const csv = generateResultsCsv(rows);
        downloadCsv(csv, "group_update_results.csv");
        addLog("Results CSV downloaded", "info");
    }, [rows, addLog]);

    // ── Render ──
    const progressPct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;
    const readyCount = rows.filter((r) => r.status === "ready").length;
    const isDisabled = processing || lookingUp;

    return (
        <div className="bugu-container">
            <h2>Bulk User Group Update</h2>

            {!apiDataLoaded && (
                <div className="bugu-banner bugu-banner--info">
                    Loading groups from database...
                </div>
            )}

            <div className="bugu-layout">
                {/* ── Left Panel: Controls ── */}
                <div className="bugu-controls-panel">
                    {/* CSV Upload */}
                    <div className="bugu-form-group">
                        <label className="bugu-label">Upload CSV</label>
                        <div
                            className={`bugu-upload-area${dragOver ? " bugu-upload-area--active" : ""}${isDisabled ? " bugu-upload-area--disabled" : ""}`}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onClick={handleBrowse}
                        >
                            <div className="bugu-upload-icon">📄</div>
                            <p className="bugu-upload-text">
                                Drag & drop your CSV file here, or click to browse
                            </p>
                            <p className="bugu-upload-subtext">
                                CSV must include columns: <code>username</code>, <code>groupName</code> |
                                Use pipe <code>|</code> for multiple groups (e.g. <code>Drivers|West</code>)
                            </p>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
                            style={{ display: "none" }}
                            onChange={handleFileChange}
                        />
                        {fileName && (
                            <div className="bugu-file-info">
                                <span>
                                    📎 {fileName} — {rows.length} row{rows.length !== 1 ? "s" : ""}
                                </span>
                                {!isDisabled && (
                                    <button className="bugu-file-clear" onClick={handleClearFile}>
                                        ✕
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Preview Table */}
                    <PreviewTable rows={rows} />

                    {/* Progress Bar */}
                    {processing && (
                        <div className="bugu-form-group">
                            <div className="bugu-progress-bar">
                                <div
                                    className="bugu-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <div className="bugu-progress-label">
                                {progress}/{progressTotal} users processed ({progressPct}%)
                            </div>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="bugu-btn-row">
                        <button
                            className="bugu-btn-full bugu-btn-primary"
                            disabled={isDisabled || readyCount === 0}
                            onClick={handleUpdate}
                        >
                            {processing
                                ? "Updating..."
                                : lookingUp
                                ? "Looking up users..."
                                : `Update Groups${readyCount > 0 ? ` (${readyCount})` : ""}`}
                        </button>
                        {completed && (
                            <button
                                className="bugu-btn-full bugu-btn-secondary"
                                onClick={handleDownloadResults}
                            >
                                Download Results
                            </button>
                        )}
                    </div>
                </div>

                {/* ── Right Panel: Log ── */}
                <div className="bugu-log-panel">
                    <div className="bugu-log-header">
                        <h3 style={{ margin: 0, fontSize: 14, color: "#394049" }}>
                            Progress Log{" "}
                            <span className="bugu-log-count">({logs.length})</span>
                        </h3>
                        {logs.length > 0 && (
                            <button
                                className="bugu-log-clear"
                                onClick={() => setLogs([])}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="bugu-log-area">
                        {logs.length === 0 ? (
                            <div className="bugu-log-empty">
                                Logs will appear here during processing...
                            </div>
                        ) : (
                            <>
                                {logs.map((entry, i) => (
                                    <LogEntry key={i} {...entry} />
                                ))}
                                <div ref={logEndRef} />
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
