import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Constants ──
const REFRESH_INTERVAL_SEC = 300; // 5 minutes
const MEDIA_SERVICES_BASE = "https://media-services.geotab.com/api";

// ── API Helpers ──
const apiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.call(method, params, resolve, reject);
    });

const getSession = (api) =>
    new Promise((resolve) => {
        api.getSession(resolve);
    });

// ── Status Derivation ──
const deriveStatus = (cameraStatus, goIsCommunicating) => {
    if (goIsCommunicating === null) return "unknown";
    const camLower = (cameraStatus || "").toLowerCase();
    if (camLower === "online" && goIsCommunicating) return "online";
    if (camLower === "standby" && goIsCommunicating) return "standby";
    if ((camLower === "offline" || camLower === "not communicating") && goIsCommunicating) return "camera-offline";
    if (!goIsCommunicating) return "go-offline";
    return "unknown";
};

const STATUS_ORDER = {
    "camera-offline": 0,
    "go-offline": 1,
    "unknown": 2,
    "standby": 3,
    "online": 4,
};

const STATUS_LABELS = {
    "online": "Online",
    "standby": "Standby",
    "camera-offline": "Camera Offline",
    "go-offline": "GO Device Offline",
    "unknown": "Unknown",
};

const STATUS_CARD_KEYS = ["total", "online", "standby", "camera-offline", "go-offline", "unhealthy"];
const STATUS_CARD_LABELS = {
    total: "Total Cameras",
    online: "Online",
    standby: "Standby",
    "camera-offline": "Camera Offline",
    "go-offline": "GO Device Offline",
    unhealthy: "Unhealthy",
};

// ── Format helpers ──
const formatTime = (dateStr) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
    });
};

const formatCountdown = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
};

const formatRefreshTime = (date) => {
    if (!date) return "—";
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════
export default function CameraHealthReport({ geotabApi }) {
    const [cameras, setCameras] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastRefresh, setLastRefresh] = useState(null);
    const [countdown, setCountdown] = useState(REFRESH_INTERVAL_SEC);
    const [searchText, setSearchText] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [cardFilter, setCardFilter] = useState(null);
    const timerRef = useRef(null);
    const countdownRef = useRef(null);

    // ── Fetch all data ──
    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const session = await getSession(geotabApi);
            const database = session.database;
            const sessionId = session.sessionId;
            const userName = session.userName;

            // Parallel fetch: media-services + MyGeotab devices + device status
            const [mappingsRes, devices, statusInfos] = await Promise.all([
                fetch(`${MEDIA_SERVICES_BASE}/DeviceMappings`, {
                    headers: {
                        "x-myg-db": database,
                        "x-myg-sessid": sessionId,
                        "x-myg-user": userName,
                    },
                }).then((r) => {
                    if (!r.ok) throw new Error(`Media Services returned ${r.status}`);
                    return r.json();
                }),
                apiCall(geotabApi, "Get", { typeName: "Device" }),
                apiCall(geotabApi, "Get", { typeName: "DeviceStatusInfo" }),
            ]);

            // Build lookup maps
            const deviceBySerial = {};
            const deviceById = {};
            for (const dev of devices) {
                if (dev.serialNumber) deviceBySerial[dev.serialNumber] = dev;
                deviceById[dev.id] = dev;
            }

            const statusByDeviceId = {};
            for (const si of statusInfos) {
                if (si.device?.id) statusByDeviceId[si.device.id] = si;
            }

            // Join camera mappings with GO device data
            const joined = (mappingsRes || []).map((cam) => {
                const goSerial = cam.associatedDeviceSerialNumber || "";
                const goDevice = deviceBySerial[goSerial] || null;
                const goStatusInfo = goDevice ? statusByDeviceId[goDevice.id] || null : null;
                const goIsCommunicating = goStatusInfo
                    ? goStatusInfo.isCommunicating !== undefined
                        ? goStatusInfo.isCommunicating
                        : goStatusInfo.isDeviceCommunicating !== undefined
                            ? goStatusInfo.isDeviceCommunicating
                            : null
                    : null;

                const effectiveStatus = deriveStatus(cam.status, goIsCommunicating);
                const cameraHealth = cam.health || "Unknown";
                const healthErrors = (cam.healthErrors || []).join(", ");

                return {
                    vehicleName: goDevice ? goDevice.name : cam.associatedDeviceName || "Unknown Vehicle",
                    cameraStatus: cam.status || "Unknown",
                    cameraHealth,
                    lastRecordingOk: cam.lastRecordingDate ? formatTime(cam.lastRecordingDate) : "—",
                    goDeviceStatus: goIsCommunicating === null
                        ? "No Match"
                        : goIsCommunicating
                            ? "Communicating"
                            : "Not Communicating",
                    cameraSerial: cam.serialNumber || "—",
                    goSerial: goSerial || "—",
                    cameraLastSeen: cam.lastCommunicationDate ? formatTime(cam.lastCommunicationDate) : "—",
                    goLastContact: goStatusInfo && goStatusInfo.dateTime
                        ? formatTime(goStatusInfo.dateTime)
                        : "—",
                    healthErrors: healthErrors || "—",
                    effectiveStatus,
                    isUnhealthy: cameraHealth.toLowerCase() !== "healthy" && cameraHealth.toLowerCase() !== "unknown",
                };
            });

            // Default sort: problems first
            joined.sort((a, b) => (STATUS_ORDER[a.effectiveStatus] ?? 99) - (STATUS_ORDER[b.effectiveStatus] ?? 99));

            setCameras(joined);
            setLastRefresh(new Date());
            setCountdown(REFRESH_INTERVAL_SEC);
        } catch (err) {
            setError(err.message || "Failed to fetch camera data");
        } finally {
            setLoading(false);
        }
    }, [geotabApi]);

    // ── Auto-refresh timer ──
    useEffect(() => {
        fetchData();

        timerRef.current = setInterval(() => {
            fetchData();
        }, REFRESH_INTERVAL_SEC * 1000);

        countdownRef.current = setInterval(() => {
            setCountdown((prev) => (prev > 0 ? prev - 1 : REFRESH_INTERVAL_SEC));
        }, 1000);

        return () => {
            clearInterval(timerRef.current);
            clearInterval(countdownRef.current);
        };
    }, [fetchData]);

    const handleRefreshNow = () => {
        clearInterval(timerRef.current);
        clearInterval(countdownRef.current);
        fetchData();
        timerRef.current = setInterval(fetchData, REFRESH_INTERVAL_SEC * 1000);
        countdownRef.current = setInterval(() => {
            setCountdown((prev) => (prev > 0 ? prev - 1 : REFRESH_INTERVAL_SEC));
        }, 1000);
    };

    // ── Counts ──
    const counts = {
        total: cameras.length,
        online: cameras.filter((c) => c.effectiveStatus === "online").length,
        standby: cameras.filter((c) => c.effectiveStatus === "standby").length,
        "camera-offline": cameras.filter((c) => c.effectiveStatus === "camera-offline").length,
        "go-offline": cameras.filter((c) => c.effectiveStatus === "go-offline").length,
        unhealthy: cameras.filter((c) => c.isUnhealthy).length,
    };

    // ── Filtering ──
    const activeFilter = cardFilter || statusFilter;

    const filtered = cameras.filter((cam) => {
        // Text search
        if (searchText) {
            const q = searchText.toLowerCase();
            const matchesText =
                cam.vehicleName.toLowerCase().includes(q) ||
                cam.cameraSerial.toLowerCase().includes(q) ||
                cam.goSerial.toLowerCase().includes(q);
            if (!matchesText) return false;
        }
        // Status filter
        if (activeFilter && activeFilter !== "all" && activeFilter !== "total") {
            if (activeFilter === "unhealthy") return cam.isUnhealthy;
            return cam.effectiveStatus === activeFilter;
        }
        return true;
    });

    // ── Card click handler ──
    const handleCardClick = (key) => {
        if (cardFilter === key) {
            setCardFilter(null);
            setStatusFilter("all");
        } else {
            setCardFilter(key);
            setStatusFilter(key);
        }
    };

    // ── Sorting ──
    const [sortCol, setSortCol] = useState(null);
    const [sortDir, setSortDir] = useState("asc");

    const handleSort = (col) => {
        if (sortCol === col) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortCol(col);
            setSortDir("asc");
        }
    };

    const sortedData = [...filtered];
    if (sortCol) {
        sortedData.sort((a, b) => {
            const aVal = a[sortCol] || "";
            const bVal = b[sortCol] || "";
            const cmp = String(aVal).localeCompare(String(bVal), undefined, { sensitivity: "base" });
            return sortDir === "asc" ? cmp : -cmp;
        });
    }

    const sortIndicator = (col) => {
        if (sortCol !== col) return "";
        return sortDir === "asc" ? " ▲" : " ▼";
    };

    // ── Render ──
    return (
        <div className="chr-container">
            <h2 className="chr-title">Camera Health Report</h2>

            {/* Summary Cards */}
            <div className="chr-cards">
                {STATUS_CARD_KEYS.map((key) => (
                    <button
                        key={key}
                        className={`chr-card chr-card--${key}${activeFilter === key ? " chr-card--active" : ""}`}
                        onClick={() => handleCardClick(key)}
                    >
                        <div className="chr-card-count">{counts[key]}</div>
                        <div className="chr-card-label">{STATUS_CARD_LABELS[key]}</div>
                    </button>
                ))}
            </div>

            {/* Refresh Bar */}
            <div className="chr-refresh-bar">
                <span className="chr-refresh-info">
                    Last refreshed: {formatRefreshTime(lastRefresh)}
                    {" | "}
                    Next refresh in {formatCountdown(countdown)}
                </span>
                <button
                    className="chr-btn chr-btn--refresh"
                    onClick={handleRefreshNow}
                    disabled={loading}
                >
                    {loading ? "Refreshing…" : "Refresh Now"}
                </button>
            </div>

            {/* Error Banner */}
            {error && (
                <div className="chr-banner chr-banner--error">
                    <span>{error}</span>
                    <button className="chr-banner-close" onClick={() => setError(null)}>×</button>
                </div>
            )}

            {/* Filter Bar */}
            <div className="chr-filter-bar">
                <input
                    type="text"
                    className="chr-search"
                    placeholder="Search vehicle name, camera serial, GO serial…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
                <select
                    className="chr-status-select"
                    value={activeFilter || "all"}
                    onChange={(e) => {
                        setStatusFilter(e.target.value);
                        setCardFilter(e.target.value === "all" ? null : e.target.value);
                    }}
                >
                    <option value="all">All Statuses</option>
                    <option value="online">Online</option>
                    <option value="standby">Standby</option>
                    <option value="camera-offline">Camera Offline</option>
                    <option value="go-offline">GO Device Offline</option>
                    <option value="unhealthy">Unhealthy</option>
                </select>
                <span className="chr-result-count">
                    {filtered.length} of {cameras.length} cameras
                </span>
            </div>

            {/* Data Table */}
            <div className="chr-table-wrap">
                <table className="chr-table">
                    <thead>
                        <tr>
                            {[
                                ["vehicleName", "Vehicle Name"],
                                ["cameraStatus", "Camera Status"],
                                ["cameraHealth", "Camera Health"],
                                ["lastRecordingOk", "Last Recording OK"],
                                ["goDeviceStatus", "GO Device Status"],
                                ["cameraSerial", "Camera Serial"],
                                ["goSerial", "GO Serial"],
                                ["cameraLastSeen", "Camera Last Seen"],
                                ["goLastContact", "GO Last Contact"],
                                ["healthErrors", "Health Errors"],
                            ].map(([col, label]) => (
                                <th key={col} onClick={() => handleSort(col)}>
                                    {label}{sortIndicator(col)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {loading && cameras.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="chr-table-empty">
                                    Loading camera data…
                                </td>
                            </tr>
                        ) : sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="chr-table-empty">
                                    No cameras match the current filters.
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((cam, i) => (
                                <tr key={i}>
                                    <td title={cam.vehicleName}>{cam.vehicleName}</td>
                                    <td>
                                        <span className={`chr-badge chr-badge--${cam.effectiveStatus}`}>
                                            {STATUS_LABELS[cam.effectiveStatus] || cam.cameraStatus}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`chr-health chr-health--${cam.cameraHealth.toLowerCase()}`}>
                                            {cam.cameraHealth}
                                        </span>
                                    </td>
                                    <td>{cam.lastRecordingOk}</td>
                                    <td>
                                        <span className={`chr-go-status chr-go-status--${cam.goDeviceStatus === "Communicating" ? "ok" : "bad"}`}>
                                            {cam.goDeviceStatus}
                                        </span>
                                    </td>
                                    <td className="chr-mono">{cam.cameraSerial}</td>
                                    <td className="chr-mono">{cam.goSerial}</td>
                                    <td>{cam.cameraLastSeen}</td>
                                    <td>{cam.goLastContact}</td>
                                    <td title={cam.healthErrors} className="chr-errors-cell">{cam.healthErrors}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
