/**
 * BulkUserUpload — React MyGeotab Add-In
 *
 * Bulk-creates users in a MyGeotab database from a CSV file.
 * Features a template builder for selecting optional User fields,
 * drag-and-drop CSV upload, batched multiCall with rate limiting,
 * and results export.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";

// ── Constants ──
const BATCH_SIZE = 100;
const RATE_LIMIT_PAUSE_MS = 61_000;

const MANDATORY_FIELDS = ["name", "firstName", "lastName"];

const OPTIONAL_FIELD_GROUPS = [
    {
        label: "Identity & Personal",
        fields: [
            "employeeNo",
            "comment",
            "designation",
            "phoneNumber",
            "phoneNumberExtension",
            "companyName",
            "companyAddress",
            "countryCode",
        ],
    },
    {
        label: "Driver / HOS",
        fields: [
            "isDriver",
            "hosRuleSet",
            "authorityName",
            "authorityAddress",
            "carrierNumber",
            "isAdverseDrivingEnabled",
            "isExemptHOSEnabled",
            "isPersonalConveyanceEnabled",
            "isYardMoveEnabled",
            "maxPCDistancePerDay",
        ],
    },
    {
        label: "Groups",
        fields: [
            "companyGroups",
            "securityGroups",
            "reportGroups",
            "privateUserGroups",
        ],
    },
    {
        label: "Preferences",
        fields: [
            "timeZoneId",
            "isMetric",
            "fuelEconomyUnit",
            "electricEnergyEconomyUnit",
            "language",
            "dateFormat",
            "firstDayOfWeek",
            "defaultPage",
            "displayCurrency",
            "defaultMapEngine",
            "zoneDisplayMode",
        ],
    },
    {
        label: "Account",
        fields: [
            "password",
            "userAuthenticationType",
            "changePassword",
            "activeFrom",
            "activeTo",
            "isEmailReportEnabled",
            "isNewsEnabled",
            "isLabsEnabled",
            "featurePreview",
        ],
    },
];

const BOOLEAN_FIELDS = new Set([
    "isDriver",
    "isMetric",
    "isAdverseDrivingEnabled",
    "isExemptHOSEnabled",
    "isPersonalConveyanceEnabled",
    "isYardMoveEnabled",
    "changePassword",
    "isEmailReportEnabled",
    "isNewsEnabled",
    "isLabsEnabled",
]);

const GROUP_FIELDS = new Set([
    "companyGroups",
    "securityGroups",
    "reportGroups",
    "privateUserGroups",
]);

const NUMBER_FIELDS = new Set(["maxPCDistancePerDay"]);

const DEFAULT_CONFIG = {
    timeZoneId: "America/Chicago",
    fuelEconomyUnit: "MPGUS",
    isMetric: false,
    isDriver: true,
    password: "",
    companyGroups: "GroupCompanyId",
    securityGroups: "GroupDriveUserSecurityId",
};

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

/** Parse a single CSV line handling quoted fields */
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

/** Parse CSV text with header row into array of objects */
function parseCsvWithHeaders(text) {
    // Strip BOM
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

/** Generate CSV template with selected columns */
function generateCsvTemplate(selectedFields) {
    const columns = [...MANDATORY_FIELDS, ...selectedFields];
    return columns.join(",") + "\n";
}

/** Trigger browser download of text as CSV */
function downloadCsv(content, filename) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** Generate results CSV with status columns */
function generateResultsCsv(users, headers) {
    const allCols = [...headers, "status", "error"];
    const lines = [allCols.join(",")];

    for (const user of users) {
        const values = allCols.map((col) => {
            if (col === "status") return user._status || "";
            if (col === "error") return user._error || "";
            const val = user[col] || "";
            // Quote if contains comma or quotes
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
// Entity Builder
// ══════════════════════════════════════════════════════════════

/** Parse comma-separated group IDs into [{id: ...}] */
function parseGroupIds(value) {
    if (!value) return null;
    return value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => ({ id }));
}

/** Coerce a string value to the appropriate JS type */
function coerceValue(field, value) {
    if (value === "" || value === undefined || value === null) return undefined;

    if (BOOLEAN_FIELDS.has(field)) {
        const lower = value.toString().toLowerCase();
        return lower === "true" || lower === "1" || lower === "yes";
    }
    if (NUMBER_FIELDS.has(field)) {
        const num = parseFloat(value);
        return isNaN(num) ? undefined : num;
    }
    if (GROUP_FIELDS.has(field)) {
        return parseGroupIds(value);
    }
    return value;
}

/** Build a MyGeotab User entity from a CSV row + defaults */
function buildUserEntity(row, csvHeaders, defaults) {
    const entity = {
        name: row.name,
        firstName: row.firstName,
        lastName: row.lastName,
    };

    // Apply defaults first
    if (defaults.timeZoneId) entity.timeZoneId = defaults.timeZoneId;
    if (defaults.fuelEconomyUnit) entity.fuelEconomyUnit = defaults.fuelEconomyUnit;
    if (defaults.isMetric !== undefined) entity.isMetric = defaults.isMetric;
    if (defaults.isDriver !== undefined) entity.isDriver = defaults.isDriver;
    if (defaults.password) entity.password = defaults.password;
    if (defaults.companyGroups) {
        entity.companyGroups = parseGroupIds(defaults.companyGroups);
    }
    if (defaults.securityGroups) {
        entity.securityGroups = parseGroupIds(defaults.securityGroups);
    }

    // Override with CSV column values (skip mandatory — already set)
    for (const header of csvHeaders) {
        if (MANDATORY_FIELDS.includes(header)) continue;
        const rawValue = row[header];
        if (rawValue === "" || rawValue === undefined) continue;

        const coerced = coerceValue(header, rawValue);
        if (coerced !== undefined) {
            entity[header] = coerced;
        }
    }

    return entity;
}

// ══════════════════════════════════════════════════════════════
// Batched MultiCall with Rate Limiting
// ══════════════════════════════════════════════════════════════

function countdownPause(ms, onTick) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const remaining = Math.max(0, ms - (Date.now() - start));
            if (onTick) onTick(Math.ceil(remaining / 1000));
            if (remaining <= 0) {
                clearInterval(iv);
                if (onTick) onTick(0);
                resolve();
            }
        }, 1000);
    });
}

async function batchedMultiCall(api, calls, addLog, onCountdown, onBatchDone) {
    const allResults = [];

    for (let i = 0; i < calls.length; i += BATCH_SIZE) {
        const batch = calls.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(calls.length / BATCH_SIZE);

        addLog(`Processing batch ${batchNum}/${totalBatches} (${batch.length} users)...`, "info");

        try {
            const results = await apiMultiCall(api, batch);
            // multiCall succeeded — all items in batch succeeded
            for (let j = 0; j < batch.length; j++) {
                allResults.push({ index: i + j, success: true, result: results[j] });
            }
            if (onBatchDone) onBatchDone(i + batch.length);
        } catch (err) {
            addLog(`Batch ${batchNum} multiCall failed. Falling back to sequential calls...`, "warn");
            // Fall back to individual calls
            for (let j = 0; j < batch.length; j++) {
                try {
                    const result = await apiCall(api, "Add", {
                        typeName: "User",
                        entity: batch[j][1].entity,
                    });
                    allResults.push({ index: i + j, success: true, result });
                } catch (singleErr) {
                    const errMsg =
                        typeof singleErr === "object" && singleErr !== null
                            ? singleErr.message || JSON.stringify(singleErr)
                            : String(singleErr);
                    allResults.push({ index: i + j, success: false, error: errMsg });
                }
                if (onBatchDone) onBatchDone(i + j + 1);
            }
        }

        // Rate limit pause between batches
        if (i + BATCH_SIZE < calls.length) {
            addLog(`Rate limit: waiting 61s before next batch...`, "warn");
            await countdownPause(RATE_LIMIT_PAUSE_MS, onCountdown);
        }
    }

    return allResults;
}

// ══════════════════════════════════════════════════════════════
// Sub-Components
// ══════════════════════════════════════════════════════════════

function LogEntry({ type, time, message }) {
    return (
        <div className={`buu-log-entry buu-log-entry--${type}`}>
            <span className="buu-log-dot" />
            <span className="buu-log-time">{time}</span>
            <span className="buu-log-message">{message}</span>
        </div>
    );
}

function StatusBadge({ status }) {
    return <span className={`buu-badge buu-badge--${status}`}>{status}</span>;
}

function TemplateBuilder({ selectedFields, onToggleField, onSelectAll, onClearAll, onDownload }) {
    return (
        <div className="buu-template-builder">
            <h3 className="buu-section-title">Template Builder</h3>
            <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "#5f6368", fontWeight: 600 }}>
                    MANDATORY (always included):
                </span>
                <div className="buu-mandatory-tags">
                    {MANDATORY_FIELDS.map((f) => (
                        <span key={f} className="buu-tag buu-tag--mandatory">
                            {f}
                        </span>
                    ))}
                </div>
            </div>

            {OPTIONAL_FIELD_GROUPS.map((group) => (
                <div key={group.label} className="buu-field-group">
                    <div className="buu-field-group-title">{group.label}</div>
                    <div className="buu-field-list">
                        {group.fields.map((field) => (
                            <div key={field} className="buu-field-item">
                                <input
                                    type="checkbox"
                                    id={`field-${field}`}
                                    checked={selectedFields.includes(field)}
                                    onChange={() => onToggleField(field)}
                                />
                                <label htmlFor={`field-${field}`}>{field}</label>
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            <div className="buu-template-actions">
                <button className="buu-btn-template" onClick={onDownload}>
                    Download Template
                </button>
                <button
                    className="buu-btn-template buu-btn-template--outline"
                    onClick={onSelectAll}
                >
                    Select All
                </button>
                <button
                    className="buu-btn-template buu-btn-template--outline"
                    onClick={onClearAll}
                >
                    Clear All
                </button>
            </div>
        </div>
    );
}

function DefaultsPanel({ defaults, onChange }) {
    const [open, setOpen] = useState(false);

    return (
        <div className="buu-defaults-panel">
            <button className="buu-defaults-toggle" onClick={() => setOpen(!open)}>
                <span>Default Configuration</span>
                <span className={`buu-defaults-arrow ${open ? "buu-defaults-arrow--open" : ""}`}>
                    ▼
                </span>
            </button>
            {open && (
                <div className="buu-defaults-body">
                    <p style={{ fontSize: 12, color: "#666", margin: "0 0 10px" }}>
                        These defaults apply to all users unless overridden by a CSV column value.
                    </p>
                    <div className="buu-defaults-grid">
                        <div className="buu-input-group">
                            <label className="buu-input-label">timeZoneId</label>
                            <input
                                className="buu-input"
                                value={defaults.timeZoneId}
                                onChange={(e) => onChange("timeZoneId", e.target.value)}
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">fuelEconomyUnit</label>
                            <select
                                className="buu-select"
                                value={defaults.fuelEconomyUnit}
                                onChange={(e) => onChange("fuelEconomyUnit", e.target.value)}
                            >
                                <option value="MPGUS">MPGUS</option>
                                <option value="MPGUK">MPGUK</option>
                                <option value="LitresPer100Km">LitresPer100Km</option>
                                <option value="KmPerLitre">KmPerLitre</option>
                            </select>
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">companyGroups (comma-sep IDs)</label>
                            <input
                                className="buu-input"
                                value={defaults.companyGroups}
                                onChange={(e) => onChange("companyGroups", e.target.value)}
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">securityGroups (comma-sep IDs)</label>
                            <input
                                className="buu-input"
                                value={defaults.securityGroups}
                                onChange={(e) => onChange("securityGroups", e.target.value)}
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">password</label>
                            <input
                                className="buu-input"
                                type="password"
                                value={defaults.password}
                                onChange={(e) => onChange("password", e.target.value)}
                                placeholder="(empty = user must set)"
                            />
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-isDriver"
                                checked={defaults.isDriver}
                                onChange={(e) => onChange("isDriver", e.target.checked)}
                            />
                            <label htmlFor="def-isDriver">isDriver</label>
                        </div>
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-isMetric"
                                checked={defaults.isMetric}
                                onChange={(e) => onChange("isMetric", e.target.checked)}
                            />
                            <label htmlFor="def-isMetric">isMetric</label>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function UserTable({ users, csvHeaders }) {
    if (!users || users.length === 0) return null;

    // Show mandatory fields + status, limit extra columns to keep readable
    const displayCols = [...MANDATORY_FIELDS];
    for (const h of csvHeaders) {
        if (!MANDATORY_FIELDS.includes(h) && displayCols.length < 6) {
            displayCols.push(h);
        }
    }
    displayCols.push("status");

    return (
        <div className="buu-table-wrap">
            <table className="buu-table">
                <thead>
                    <tr>
                        <th>#</th>
                        {displayCols.map((col) => (
                            <th key={col}>{col}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {users.map((user, idx) => (
                        <tr key={idx}>
                            <td>{idx + 1}</td>
                            {displayCols.map((col) => (
                                <td key={col}>
                                    {col === "status" ? (
                                        <StatusBadge status={user._status || "pending"} />
                                    ) : (
                                        user[col] || ""
                                    )}
                                </td>
                            ))}
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

export default function BulkUserUpload({ geotabApi }) {
    // Template builder state
    const [selectedFields, setSelectedFields] = useState(["employeeNo"]);

    // Defaults state
    const [defaults, setDefaults] = useState({ ...DEFAULT_CONFIG });

    // CSV / file state
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState("");
    const [csvHeaders, setCsvHeaders] = useState([]);
    const [users, setUsers] = useState([]);

    // Processing state
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [progressTotal, setProgressTotal] = useState(0);
    const [countdown, setCountdown] = useState(0);
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

    // ── Template Builder Handlers ──
    const handleToggleField = useCallback((field) => {
        setSelectedFields((prev) =>
            prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
        );
    }, []);

    const handleSelectAll = useCallback(() => {
        const allFields = OPTIONAL_FIELD_GROUPS.flatMap((g) => g.fields);
        setSelectedFields(allFields);
    }, []);

    const handleClearAll = useCallback(() => {
        setSelectedFields([]);
    }, []);

    const handleDownloadTemplate = useCallback(() => {
        const csv = generateCsvTemplate(selectedFields);
        downloadCsv(csv, "user_upload_template.csv");
        addLog(
            `Template downloaded with ${MANDATORY_FIELDS.length + selectedFields.length} columns: ${[...MANDATORY_FIELDS, ...selectedFields].join(", ")}`,
            "info"
        );
    }, [selectedFields, addLog]);

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
                const { headers, rows } = parseCsvWithHeaders(text);

                // Validate mandatory columns
                const missing = MANDATORY_FIELDS.filter((f) => !headers.includes(f));
                if (missing.length > 0) {
                    addLog(
                        `CSV missing mandatory columns: ${missing.join(", ")}. Please use the template builder.`,
                        "error"
                    );
                    return;
                }

                if (rows.length === 0) {
                    addLog("CSV has no data rows", "error");
                    return;
                }

                // Tag each row with status
                const taggedRows = rows.map((row) => ({ ...row, _status: "pending", _error: "" }));

                setFileName(file.name);
                setCsvHeaders(headers);
                setUsers(taggedRows);
                setCompleted(false);
                addLog(`Loaded ${rows.length} users from ${file.name} (${headers.length} columns)`, "success");
            };
            reader.readAsText(file);
        },
        [addLog]
    );

    const handleDrop = useCallback(
        (e) => {
            e.preventDefault();
            setDragOver(false);
            if (processing) return;
            const file = e.dataTransfer.files[0];
            processFile(file);
        },
        [processing, processFile]
    );

    const handleDragOver = useCallback(
        (e) => {
            e.preventDefault();
            if (!processing) setDragOver(true);
        },
        [processing]
    );

    const handleDragLeave = useCallback(() => setDragOver(false), []);

    const handleBrowse = useCallback(() => {
        if (!processing) fileInputRef.current?.click();
    }, [processing]);

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
        setCsvHeaders([]);
        setUsers([]);
        setCompleted(false);
    }, []);

    // ── Defaults Handler ──
    const handleDefaultChange = useCallback((key, value) => {
        setDefaults((prev) => ({ ...prev, [key]: value }));
    }, []);

    // ── Upload Handler ──
    const handleUpload = useCallback(async () => {
        if (!geotabApi || users.length === 0) return;

        setProcessing(true);
        setProgress(0);
        setProgressTotal(users.length);
        setCompleted(false);

        addLog(`Starting upload of ${users.length} users...`, "info");

        // Build multiCall array
        const calls = users.map((user) => {
            const entity = buildUserEntity(user, csvHeaders, defaults);
            return ["Add", { typeName: "User", entity }];
        });

        // Mark all as uploading
        setUsers((prev) => prev.map((u) => ({ ...u, _status: "uploading" })));

        const results = await batchedMultiCall(
            geotabApi,
            calls,
            addLog,
            (sec) => setCountdown(sec),
            (done) => setProgress(done)
        );

        // Apply results
        let successCount = 0;
        let failCount = 0;

        setUsers((prev) => {
            const updated = [...prev];
            for (const r of results) {
                if (r.success) {
                    updated[r.index] = { ...updated[r.index], _status: "success", _error: "" };
                    successCount++;
                } else {
                    updated[r.index] = { ...updated[r.index], _status: "failed", _error: r.error };
                    failCount++;
                }
            }
            return updated;
        });

        addLog(
            `Upload complete: ${successCount} succeeded, ${failCount} failed out of ${users.length} total`,
            failCount > 0 ? "warn" : "success"
        );

        setProcessing(false);
        setCompleted(true);
        setCountdown(0);
    }, [geotabApi, users, csvHeaders, defaults, addLog]);

    // ── Download Results ──
    const handleDownloadResults = useCallback(() => {
        const csv = generateResultsCsv(users, csvHeaders);
        downloadCsv(csv, "user_upload_results.csv");
        addLog("Results CSV downloaded", "info");
    }, [users, csvHeaders, addLog]);

    // ── Render ──
    const progressPct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;

    return (
        <div className="buu-container">
            <h2>Bulk User Upload</h2>
            <div className="buu-layout">
                {/* ── Left Panel: Controls ── */}
                <div className="buu-controls-panel">
                    {/* Template Builder */}
                    <TemplateBuilder
                        selectedFields={selectedFields}
                        onToggleField={handleToggleField}
                        onSelectAll={handleSelectAll}
                        onClearAll={handleClearAll}
                        onDownload={handleDownloadTemplate}
                    />

                    {/* CSV Upload */}
                    <div className="buu-form-group">
                        <label className="buu-label">Upload CSV</label>
                        <div
                            className={`buu-upload-area${dragOver ? " buu-upload-area--active" : ""}${processing ? " buu-upload-area--disabled" : ""}`}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onClick={handleBrowse}
                        >
                            <div className="buu-upload-icon">📄</div>
                            <p className="buu-upload-text">
                                Drag & drop your CSV file here, or click to browse
                            </p>
                            <p className="buu-upload-subtext">
                                CSV must include: {MANDATORY_FIELDS.join(", ")}
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
                            <div className="buu-file-info">
                                <span>
                                    📎 {fileName} — {users.length} user{users.length !== 1 ? "s" : ""}
                                </span>
                                {!processing && (
                                    <button className="buu-file-clear" onClick={handleClearFile}>
                                        ✕
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Preview Table */}
                    <UserTable users={users} csvHeaders={csvHeaders} />

                    {/* Defaults */}
                    <DefaultsPanel defaults={defaults} onChange={handleDefaultChange} />

                    {/* Progress Bar */}
                    {processing && (
                        <div className="buu-form-group">
                            <div className="buu-progress-bar">
                                <div
                                    className="buu-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <div className="buu-progress-label">
                                {progress}/{progressTotal} users processed ({progressPct}%)
                                {countdown > 0 && ` — rate limit pause: ${countdown}s`}
                            </div>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="buu-btn-row">
                        <button
                            className="buu-btn-full buu-btn-primary"
                            disabled={processing || users.length === 0}
                            onClick={handleUpload}
                        >
                            {processing ? "Uploading..." : "Upload Users"}
                        </button>
                        {completed && (
                            <button
                                className="buu-btn-full buu-btn-secondary"
                                onClick={handleDownloadResults}
                            >
                                Download Results
                            </button>
                        )}
                    </div>
                </div>

                {/* ── Right Panel: Log ── */}
                <div className="buu-log-panel">
                    <div className="buu-log-header">
                        <h3 style={{ margin: 0, fontSize: 14, color: "#394049" }}>
                            Progress Log{" "}
                            <span className="buu-log-count">({logs.length})</span>
                        </h3>
                        {logs.length > 0 && (
                            <button
                                className="buu-log-clear"
                                onClick={() => setLogs([])}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="buu-log-area">
                        {logs.length === 0 ? (
                            <div className="buu-log-empty">
                                Logs will appear here during upload...
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
