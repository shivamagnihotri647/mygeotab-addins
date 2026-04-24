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

/** Direct API call bypassing the SDK (preserves all entity properties like nullifyAccessGroupFilter) */
const directApiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.getSession((session) => {
            const server = session.server || "my.geotab.com";
            const url = `https://${server}/apiv1`;
            const payload = JSON.stringify({
                method,
                params: {
                    credentials: {
                        database: session.database,
                        sessionId: session.sessionId,
                        userName: session.userName,
                    },
                    ...params,
                },
            });
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: payload,
            })
                .then((r) => r.json())
                .then((data) => {
                    if (data.error) reject(data.error.message || JSON.stringify(data.error));
                    else resolve(data.result);
                })
                .catch(reject);
        });
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
    if (!value) return { groups: null, unresolved: [] };
    const parts = value.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return { groups: null, unresolved: [] };

    const resolved = [];
    const unresolved = [];
    for (const part of parts) {
        const match = groupCache && (groupCache[part] || groupCache[part.toLowerCase()]);
        if (match) {
            resolved.push({ id: match.id });
        } else {
            unresolved.push(part);
        }
    }
    return { groups: resolved.length > 0 ? resolved : null, unresolved };
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
    // Mode toggle: "csv" or "remove"
    const [mode, setMode] = useState("csv");

    // API data caches
    const [groupCache, setGroupCache] = useState(null);
    const [groupIdToName, setGroupIdToName] = useState({});
    const [allGroups, setAllGroups] = useState([]);
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

    // Remove Group mode state
    const [groupType, setGroupType] = useState("companyGroups");
    const [selectedGroup, setSelectedGroup] = useState("");
    const [groupUsers, setGroupUsers] = useState([]);
    const [selectedUserIds, setSelectedUserIds] = useState(new Set());
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [removeCompleted, setRemoveCompleted] = useState(false);
    const [removeRows, setRemoveRows] = useState([]);

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
                const groups = await apiCall(geotabApi, "Get", { typeName: "Group", resultsLimit: 100000 });
                if (cancelled) return;

                const cache = {};
                const idMap = {};
                for (const g of groups) {
                    const name = g.name || g.id;
                    cache[name] = g;
                    const lower = name.toLowerCase();
                    if (lower !== name && !cache[lower]) {
                        cache[lower] = g;
                    }
                    idMap[g.id] = name;
                }
                setGroupCache(cache);
                setGroupIdToName(idMap);
                setAllGroups(groups);
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

            // Validate group names in CSV against loaded cache
            let usersWithBadGroups = 0;
            const allUnresolved = new Set();
            for (const row of updated) {
                if (row.status === "ready") {
                    const { unresolved } = resolveGroups(row.groupName, groupCache);
                    if (unresolved.length > 0) {
                        usersWithBadGroups++;
                        unresolved.forEach((g) => allUnresolved.add(g));
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

            if (usersWithBadGroups > 0) {
                const samples = [...allUnresolved].slice(0, 5).join(", ");
                addLog(
                    `WARNING: ${usersWithBadGroups} user(s) reference ${allUnresolved.size} group name(s) not found in database. Samples: ${samples}${allUnresolved.size > 5 ? " ..." : ""}`,
                    "error"
                );
                addLog(
                    `Total groups loaded: ${Object.keys(groupCache).length}. If groups are missing, the logged-in user may not have visibility to them.`,
                    "warn"
                );
            }

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

    // ── Build new GroupFilter condition for target groups ──
    function buildGroupFilterCondition(groups) {
        if (groups.length === 1) {
            return { groupId: groups[0].id };
        }
        return {
            relation: "Or",
            groupFilterConditions: groups.map(g => ({ groupId: g.id })),
        };
    }

    // ── Update a single user's groups ──
    async function updateSingleUser(api, userEntity, newGroups, addLog) {
        // Re-fetch user fresh
        const users = await apiCall(api, "Get", {
            typeName: "User",
            search: { name: userEntity.name },
        });
        if (!users || users.length === 0) {
            throw new Error("User not found: " + userEntity.name);
        }
        const user = users[0];

        // Set new companyGroups
        user.companyGroups = newGroups;
        if (user.isDriver) {
            user.driverGroups = newGroups;
        }

        // If user has an accessGroupFilter, nullify it (same approach as MyGeotab UI)
        if (user.accessGroupFilter?.id) {
            delete user.accessGroupFilter;
            user.nullifyAccessGroupFilter = true;
        }

        // Sanitize entity to avoid GenericException on auto-created users
        if (!user.phoneNumber && user.phoneNumber !== "") user.phoneNumber = "";
        if (!user.phoneNumberExtension && user.phoneNumberExtension !== "") user.phoneNumberExtension = "";
        delete user.isAutoAdded;
        if (user.securityGroups) {
            user.securityGroups = user.securityGroups.map(g => ({ id: g.id }));
        }
        if (user.issuerCertificate) {
            user.issuerCertificate = { id: user.issuerCertificate.id };
        }

        // Use direct API call to bypass SDK (SDK strips nullifyAccessGroupFilter)
        await directApiCall(api, "Set", { typeName: "User", entity: user });
    }

    // ══════════════════════════════════════════════════════════════
    // Remove Group Mode — Functions
    // ══════════════════════════════════════════════════════════════

    // System group IDs that should not appear in the dropdown
    const SYSTEM_GROUP_IDS = new Set([
        "GroupCompanyId",
        "GroupEverythingSecurityId",
        "GroupNothingSecurityId",
        "GroupSupervisorsSecurityId",
        "GroupUserSecurityId",
        "GroupViewOnlySecurityId",
        "GroupDriveUserSecurityId",
        "GroupPersonalGroup",
    ]);

    /** Get groups list for dropdown, filtered to non-system groups, sorted alphabetically */
    const dropdownGroups = React.useMemo(() => {
        return allGroups
            .filter((g) => !SYSTEM_GROUP_IDS.has(g.id) && g.name)
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }, [allGroups]);

    /** Load all users who have the selected group in the chosen groupType */
    const loadUsersWithGroup = useCallback(async () => {
        if (!geotabApi || !selectedGroup) return;

        setLoadingUsers(true);
        setGroupUsers([]);
        setSelectedUserIds(new Set());
        setRemoveCompleted(false);
        setRemoveRows([]);
        addLog(`Loading users with group "${groupIdToName[selectedGroup] || selectedGroup}" in ${groupType}...`, "info");

        try {
            const users = await apiCall(geotabApi, "Get", {
                typeName: "User",
                search: { [groupType]: [{ id: selectedGroup }] },
            });

            if (users.length === 0) {
                addLog("No users found with this group assignment", "warn");
            } else {
                addLog(`Found ${users.length} user(s) with this group`, "success");
            }

            setGroupUsers(users);
        } catch (err) {
            addLog("Failed to load users: " + parseErrorMessage(err), "error");
        } finally {
            setLoadingUsers(false);
        }
    }, [geotabApi, selectedGroup, groupType, groupIdToName, addLog]);

    /** Toggle a single user selection */
    const toggleUserSelection = useCallback((userId) => {
        setSelectedUserIds((prev) => {
            const next = new Set(prev);
            if (next.has(userId)) next.delete(userId);
            else next.add(userId);
            return next;
        });
    }, []);

    /** Toggle select all */
    const toggleSelectAll = useCallback(() => {
        if (selectedUserIds.size === groupUsers.length) {
            setSelectedUserIds(new Set());
        } else {
            setSelectedUserIds(new Set(groupUsers.map((u) => u.id)));
        }
    }, [selectedUserIds, groupUsers]);

    /** Remove the selected group from selected users */
    const handleRemoveGroup = useCallback(async () => {
        if (!geotabApi || selectedUserIds.size === 0 || !selectedGroup) return;

        const targetUsers = groupUsers.filter((u) => selectedUserIds.has(u.id));
        const groupName = groupIdToName[selectedGroup] || selectedGroup;

        setProcessing(true);
        setProgress(0);
        setProgressTotal(targetUsers.length);
        setRemoveCompleted(false);

        addLog(`Removing group "${groupName}" from ${targetUsers.length} user(s)...`, "info");

        const results = [];
        let successCount = 0;
        let failCount = 0;
        let processed = 0;

        for (const targetUser of targetUsers) {
            try {
                // Re-fetch user fresh
                const users = await apiCall(geotabApi, "Get", {
                    typeName: "User",
                    search: { name: targetUser.name },
                });
                if (!users || users.length === 0) throw new Error("User not found");
                const user = users[0];

                const prevGroups = formatGroups(user[groupType], groupIdToName);

                // Filter out the target group
                user[groupType] = (user[groupType] || []).filter((g) => g.id !== selectedGroup);

                // If removing from companyGroups and user is a driver, also remove from driverGroups
                if (groupType === "companyGroups" && user.isDriver) {
                    user.driverGroups = (user.driverGroups || []).filter((g) => g.id !== selectedGroup);
                }

                // Ensure companyGroups is not empty (MyGeotab requires at least one)
                if (groupType === "companyGroups" && user.companyGroups.length === 0) {
                    throw new Error("Cannot remove last companyGroup — user must have at least one");
                }

                // Handle accessGroupFilter
                if (user.accessGroupFilter?.id) {
                    delete user.accessGroupFilter;
                    user.nullifyAccessGroupFilter = true;
                }

                // Sanitize entity
                if (!user.phoneNumber && user.phoneNumber !== "") user.phoneNumber = "";
                if (!user.phoneNumberExtension && user.phoneNumberExtension !== "") user.phoneNumberExtension = "";
                delete user.isAutoAdded;
                if (user.securityGroups) {
                    user.securityGroups = user.securityGroups.map((g) => ({ id: g.id }));
                }
                if (user.issuerCertificate) {
                    user.issuerCertificate = { id: user.issuerCertificate.id };
                }

                await directApiCall(geotabApi, "Set", { typeName: "User", entity: user });

                successCount++;
                addLog(`Removed "${groupName}" from ${user.name}`, "success");
                results.push({ username: user.name, groupName, previousGroups: prevGroups, status: "success", error: "" });
            } catch (err) {
                const errMsg = parseErrorMessage(err);
                failCount++;
                addLog(`Failed: ${targetUser.name} — ${errMsg}`, "error");
                results.push({ username: targetUser.name, groupName, previousGroups: "", status: "failed", error: errMsg });
            }

            processed++;
            setProgress(processed);

            if (processed % BATCH_SIZE === 0 && processed < targetUsers.length) {
                await batchDelay(BATCH_DELAY_MS);
            }
        }

        addLog(
            `Removal complete: ${successCount} succeeded, ${failCount} failed out of ${processed} total`,
            failCount > 0 ? "warn" : "success"
        );

        setRemoveRows(results);
        setProcessing(false);
        setRemoveCompleted(true);
    }, [geotabApi, groupUsers, selectedUserIds, selectedGroup, groupType, groupIdToName, addLog]);

    /** Download remove-mode results CSV */
    const handleDownloadRemoveResults = useCallback(() => {
        const csv = generateResultsCsv(removeRows);
        downloadCsv(csv, "group_removal_results.csv");
        addLog("Results CSV downloaded", "info");
    }, [removeRows, addLog]);

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

        // Process users sequentially (each needs a GroupFilter fetch + Set)
        let successCount = 0;
        let failCount = 0;
        let processed = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.status !== "ready" && row.status !== "updating") continue;
            if (!row._userEntity) continue;

            const { groups: newGroups, unresolved } = resolveGroups(row.groupName, groupCache);
            if (!newGroups) {
                const errMsg = unresolved.length > 0
                    ? `Groups not found in database: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ` (+${unresolved.length - 5} more)` : ""}`
                    : "Could not resolve group name(s)";
                setRows((prev) => {
                    const u = [...prev];
                    u[i] = { ...u[i], status: "failed", error: errMsg };
                    return u;
                });
                failCount++;
                processed++;
                setProgress(processed);
                addLog(`Failed: ${row.username} -- ${errMsg}`, "error");
                continue;
            }
            if (unresolved.length > 0) {
                addLog(`Warning: ${row.username} -- ${unresolved.length} group(s) not found, using ${newGroups.length} resolved groups`, "warn");
            }

            try {
                await updateSingleUser(geotabApi, row._userEntity, newGroups, addLog);
                setRows((prev) => {
                    const u = [...prev];
                    u[i] = { ...u[i], status: "success", error: "" };
                    return u;
                });
                successCount++;
            } catch (err) {
                const errMsg = parseErrorMessage(err);
                setRows((prev) => {
                    const u = [...prev];
                    u[i] = { ...u[i], status: "failed", error: errMsg };
                    return u;
                });
                failCount++;
                addLog(`Failed: ${row.username} — ${errMsg}`, "error");
            }

            processed++;
            setProgress(processed);

            // Rate limit delay every BATCH_SIZE users
            if (processed % BATCH_SIZE === 0 && processed < updatable.length) {
                await batchDelay(BATCH_DELAY_MS);
            }
        }

        addLog(
            `Update complete: ${successCount} succeeded, ${failCount} failed out of ${successCount + failCount} total`,
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

    const allUsersSelected = groupUsers.length > 0 && selectedUserIds.size === groupUsers.length;

    return (
        <div className="bugu-container">
            <h2>Bulk User Group Update</h2>

            {/* Mode Tabs */}
            <div className="bugu-mode-tabs">
                <button
                    className={`bugu-mode-tab${mode === "csv" ? " bugu-mode-tab--active" : ""}`}
                    onClick={() => setMode("csv")}
                    disabled={processing || lookingUp || loadingUsers}
                >
                    Update Groups (CSV)
                </button>
                <button
                    className={`bugu-mode-tab${mode === "remove" ? " bugu-mode-tab--active" : ""}`}
                    onClick={() => setMode("remove")}
                    disabled={processing || lookingUp || loadingUsers}
                >
                    Remove Group
                </button>
            </div>

            {!apiDataLoaded && (
                <div className="bugu-banner bugu-banner--info">
                    Loading groups from database...
                </div>
            )}

            <div className="bugu-layout">
                {/* ── Left Panel: Controls ── */}
                <div className="bugu-controls-panel">
                    {/* ═══ CSV MODE ═══ */}
                    {mode === "csv" && (
                        <>
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
                        </>
                    )}

                    {/* ═══ REMOVE GROUP MODE ═══ */}
                    {mode === "remove" && (
                        <>
                            {/* Group Type Selector */}
                            <div className="bugu-form-group">
                                <label className="bugu-label">Group Type</label>
                                <div className="bugu-radio-group">
                                    <label className="bugu-radio-item">
                                        <input
                                            type="radio"
                                            name="groupType"
                                            value="companyGroups"
                                            checked={groupType === "companyGroups"}
                                            onChange={(e) => setGroupType(e.target.value)}
                                            disabled={processing || loadingUsers}
                                        />
                                        <span>Company Groups</span>
                                    </label>
                                    <label className="bugu-radio-item">
                                        <input
                                            type="radio"
                                            name="groupType"
                                            value="reportGroups"
                                            checked={groupType === "reportGroups"}
                                            onChange={(e) => setGroupType(e.target.value)}
                                            disabled={processing || loadingUsers}
                                        />
                                        <span>Report Groups</span>
                                    </label>
                                    <label className="bugu-radio-item">
                                        <input
                                            type="radio"
                                            name="groupType"
                                            value="driverGroups"
                                            checked={groupType === "driverGroups"}
                                            onChange={(e) => setGroupType(e.target.value)}
                                            disabled={processing || loadingUsers}
                                        />
                                        <span>Driver Groups</span>
                                    </label>
                                </div>
                                {groupType === "driverGroups" && (
                                    <p className="bugu-upload-subtext">
                                        Note: driverGroups only applies to users with isDriver=true
                                    </p>
                                )}
                            </div>

                            {/* Group Selector */}
                            <div className="bugu-form-group">
                                <label className="bugu-label">Select Group to Remove</label>
                                <select
                                    className="bugu-group-select"
                                    value={selectedGroup}
                                    onChange={(e) => setSelectedGroup(e.target.value)}
                                    disabled={processing || loadingUsers}
                                >
                                    <option value="">-- Select a group --</option>
                                    {dropdownGroups.map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {g.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Load Users Button */}
                            <div className="bugu-form-group">
                                <button
                                    className="bugu-btn-full bugu-btn-secondary"
                                    disabled={!selectedGroup || processing || loadingUsers}
                                    onClick={loadUsersWithGroup}
                                >
                                    {loadingUsers ? "Loading Users..." : "Load Users with This Group"}
                                </button>
                            </div>

                            {/* User Checklist */}
                            {groupUsers.length > 0 && (
                                <>
                                    <div className="bugu-select-count">
                                        {selectedUserIds.size} of {groupUsers.length} users selected
                                    </div>
                                    <div className="bugu-user-list">
                                        <div className="bugu-user-row bugu-user-row--header">
                                            <input
                                                type="checkbox"
                                                checked={allUsersSelected}
                                                onChange={toggleSelectAll}
                                                disabled={processing}
                                            />
                                            <span className="bugu-user-col-name">Username</span>
                                            <span className="bugu-user-col-fullname">Name</span>
                                            <span className="bugu-user-col-groups">Current {groupType}</span>
                                        </div>
                                        {groupUsers.map((user) => (
                                            <div
                                                key={user.id}
                                                className="bugu-user-row"
                                                onClick={() => !processing && toggleUserSelection(user.id)}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedUserIds.has(user.id)}
                                                    onChange={() => toggleUserSelection(user.id)}
                                                    disabled={processing}
                                                />
                                                <span className="bugu-user-col-name">{user.name}</span>
                                                <span className="bugu-user-col-fullname">
                                                    {user.firstName} {user.lastName}
                                                </span>
                                                <span className="bugu-user-col-groups" title={formatGroups(user[groupType], groupIdToName)}>
                                                    {formatGroups(user[groupType], groupIdToName)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}

                            {/* Progress Bar (Remove Mode) */}
                            {processing && mode === "remove" && (
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

                            {/* Remove Group Button */}
                            <div className="bugu-btn-row">
                                <button
                                    className="bugu-btn-full bugu-btn-primary bugu-btn-danger"
                                    disabled={processing || loadingUsers || selectedUserIds.size === 0}
                                    onClick={handleRemoveGroup}
                                >
                                    {processing
                                        ? "Removing..."
                                        : `Remove Group from ${selectedUserIds.size} User${selectedUserIds.size !== 1 ? "s" : ""}`}
                                </button>
                                {removeCompleted && (
                                    <button
                                        className="bugu-btn-full bugu-btn-secondary"
                                        onClick={handleDownloadRemoveResults}
                                    >
                                        Download Results
                                    </button>
                                )}
                            </div>
                        </>
                    )}
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
