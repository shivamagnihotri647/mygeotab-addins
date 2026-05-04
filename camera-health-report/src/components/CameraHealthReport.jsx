import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Constants ──
const REFRESH_INTERVAL_SEC = 300; // 5 minutes

// Camera diagnostic KnownIds
const DIAG_CAMERA_STATUS = "DiagnosticCameraDeviceStatusId";
const DIAG_CAMERA_HEALTH = "DiagnosticCameraHealthStatusId";

// Camera status data values (from DiagnosticCameraDeviceStatusId)
const CAM_STATUS_OFFLINE = 0;
const CAM_STATUS_ONLINE = 1;
const CAM_STATUS_STANDBY = 2;

const CAM_STATUS_LABELS = {
    [CAM_STATUS_OFFLINE]: "Offline",
    [CAM_STATUS_ONLINE]: "Online",
    [CAM_STATUS_STANDBY]: "Standby",
};

// ── API Helpers ──
const apiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.call(method, params, resolve, reject);
    });

const apiMultiCall = (api, calls) =>
    new Promise((resolve, reject) => {
        api.multiCall(calls, resolve, reject);
    });

// ── Status Derivation ──
// Combines camera device status (from StatusData) with GO device communicating flag
const deriveStatus = (camStatusValue, goIsCommunicating) => {
    if (goIsCommunicating === null) return "unknown";
    if (!goIsCommunicating) return "go-offline";
    // GO is communicating — check camera status
    if (camStatusValue === CAM_STATUS_ONLINE) return "online";
    if (camStatusValue === CAM_STATUS_STANDBY) return "standby";
    if (camStatusValue === CAM_STATUS_OFFLINE) return "camera-offline";
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
            // Step 1: Get DeviceStatusInfo with camera diagnostics.
            // The diagnostics search populates the statusData array on each
            // record with the latest values for those diagnostics.
            const statusInfos = await apiCall(geotabApi, "Get", {
                typeName: "DeviceStatusInfo",
                search: {
                    diagnostics: [
                        { id: DIAG_CAMERA_STATUS },
                        { id: DIAG_CAMERA_HEALTH },
                    ],
                },
            });

            // Step 2: Filter to devices that actually have camera data,
            // and collect their IDs so we only fetch those Devices (not all 6k+).
            const cameraInfos = [];
            const cameraDeviceIds = [];
            for (const si of statusInfos) {
                const devId = si.device?.id;
                if (!devId) continue;
                const sdArray = si.statusData || [];
                const hasCameraData = sdArray.some(
                    (sd) => sd.diagnostic?.id === DIAG_CAMERA_STATUS || sd.diagnostic?.id === DIAG_CAMERA_HEALTH
                );
                if (hasCameraData) {
                    cameraInfos.push(si);
                    cameraDeviceIds.push(devId);
                }
            }

            // Step 3: Batch-fetch only the camera-equipped devices for names/serials.
            // Uses multiCall so the server processes them in one round-trip.
            let deviceById = {};
            if (cameraDeviceIds.length > 0) {
                const deviceCalls = cameraDeviceIds.map((id) => [
                    "Get", { typeName: "Device", search: { id } },
                ]);
                const deviceResults = await apiMultiCall(geotabApi, deviceCalls);
                for (const arr of deviceResults) {
                    if (arr && arr[0]) deviceById[arr[0].id] = arr[0];
                }
            }

            // Step 4: Build joined rows
            const joined = [];
            for (const si of cameraInfos) {
                const devId = si.device.id;
                const sdArray = si.statusData || [];
                const camStatusRec = sdArray.find(
                    (sd) => sd.diagnostic?.id === DIAG_CAMERA_STATUS
                );
                const camHealthRec = sdArray.find(
                    (sd) => sd.diagnostic?.id === DIAG_CAMERA_HEALTH
                );

                const device = deviceById[devId];
                const goIsCommunicating = si.isDeviceCommunicating !== undefined
                    ? si.isDeviceCommunicating
                    : si.isCommunicating !== undefined
                        ? si.isCommunicating
                        : null;

                const camStatusValue = camStatusRec ? camStatusRec.data : null;
                const effectiveStatus = deriveStatus(camStatusValue, goIsCommunicating);

                let cameraHealth = "Unknown";
                if (camHealthRec && camHealthRec.data !== null && camHealthRec.data !== undefined) {
                    const hVal = camHealthRec.data;
                    if (hVal === 0) cameraHealth = "Healthy";
                    else if (hVal === 1) cameraHealth = "Unstable";
                    else if (hVal === 2) cameraHealth = "Not Working";
                    else if (hVal === 3) cameraHealth = "Pending";
                    else cameraHealth = `Code ${hVal}`;
                }

                joined.push({
                    vehicleName: device ? device.name : devId,
                    cameraStatus: camStatusValue !== null
                        ? (CAM_STATUS_LABELS[camStatusValue] || `Code ${camStatusValue}`)
                        : "Unknown",
                    cameraHealth,
                    goDeviceStatus: goIsCommunicating === null
                        ? "No Data"
                        : goIsCommunicating
                            ? "Communicating"
                            : "Not Communicating",
                    goSerial: device ? (device.serialNumber || "—") : "—",
                    cameraLastSeen: camStatusRec ? formatTime(camStatusRec.dateTime) : "—",
                    goLastContact: si.dateTime ? formatTime(si.dateTime) : "—",
                    healthLastChecked: camHealthRec ? formatTime(camHealthRec.dateTime) : "—",
                    effectiveStatus,
                    isUnhealthy: cameraHealth !== "Healthy" && cameraHealth !== "Unknown" && cameraHealth !== "Pending",
                });
            }

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
        if (searchText) {
            const q = searchText.toLowerCase();
            const matchesText =
                cam.vehicleName.toLowerCase().includes(q) ||
                cam.goSerial.toLowerCase().includes(q);
            if (!matchesText) return false;
        }
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

    // ── Excel Export ──
    const handleExport = () => {
        const headers = [
            "Vehicle Name", "Camera Status", "Camera Health",
            "GO Device Status", "GO Serial", "Camera Last Seen",
            "GO Last Contact", "Health Last Checked", "Effective Status",
        ];
        const rows = sortedData.map((cam) => [
            cam.vehicleName,
            cam.cameraStatus,
            cam.cameraHealth,
            cam.goDeviceStatus,
            cam.goSerial,
            cam.cameraLastSeen,
            cam.goLastContact,
            cam.healthLastChecked,
            STATUS_LABELS[cam.effectiveStatus] || cam.effectiveStatus,
        ]);

        // Build XML Spreadsheet (opens natively in Excel)
        const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const headerCells = headers.map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escXml(h)}</Data></Cell>`).join("");
        const dataRows = rows.map((row) => {
            const cells = row.map((val) => `<Cell><Data ss:Type="String">${escXml(val)}</Data></Cell>`).join("");
            return `<Row>${cells}</Row>`;
        }).join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
<Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#F5F5F5" ss:Pattern="Solid"/></Style>
</Styles>
<Worksheet ss:Name="Camera Health Report">
<Table>
${headers.map(() => '<Column ss:AutoFitWidth="1"/>').join("")}
<Row>${headerCells}</Row>
${dataRows}
</Table>
</Worksheet>
</Workbook>`;

        const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `camera-health-report-${dateStr}.xls`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // ── Column definitions ──
    const columns = [
        ["vehicleName", "Vehicle Name"],
        ["cameraStatus", "Camera Status"],
        ["cameraHealth", "Camera Health"],
        ["goDeviceStatus", "GO Device Status"],
        ["goSerial", "GO Serial"],
        ["cameraLastSeen", "Camera Last Seen"],
        ["goLastContact", "GO Last Contact"],
        ["healthLastChecked", "Health Last Checked"],
    ];

    // ── Render ──
    return (
        <div className="chr-container">
            <div className="chr-header">
                <h2 className="chr-title">Camera Health Report</h2>
                <button
                    className="chr-btn chr-btn--export"
                    onClick={handleExport}
                    disabled={sortedData.length === 0}
                >
                    Export to Excel
                </button>
            </div>

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
                    placeholder="Search vehicle name or GO serial…"
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
                            {columns.map(([col, label]) => (
                                <th key={col} onClick={() => handleSort(col)}>
                                    {label}{sortIndicator(col)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {loading && cameras.length === 0 ? (
                            <tr>
                                <td colSpan={columns.length} className="chr-table-empty">
                                    Loading camera data…
                                </td>
                            </tr>
                        ) : sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={columns.length} className="chr-table-empty">
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
                                        <span className={`chr-health chr-health--${cam.cameraHealth.toLowerCase().replace(/\s+/g, "-")}`}>
                                            {cam.cameraHealth}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`chr-go-status chr-go-status--${cam.goDeviceStatus === "Communicating" ? "ok" : "bad"}`}>
                                            {cam.goDeviceStatus}
                                        </span>
                                    </td>
                                    <td className="chr-mono">{cam.goSerial}</td>
                                    <td>{cam.cameraLastSeen}</td>
                                    <td>{cam.goLastContact}</td>
                                    <td>{cam.healthLastChecked}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
