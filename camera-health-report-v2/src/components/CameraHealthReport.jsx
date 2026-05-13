import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Constants ──
const REFRESH_INTERVAL_SEC = 300; // 5 minutes
const MEDIA_SERVICES_URL = "https://media-services.geotab.com/api/DeviceMappings";

// Camera status numeric values (for recommendation engine)
const CAM_STATUS_OFFLINE = 0;
const CAM_STATUS_ONLINE = 1;
const CAM_STATUS_STANDBY = 2;

// Map media-services status strings → numeric
const CAM_STATUS_MAP = { offline: CAM_STATUS_OFFLINE, online: CAM_STATUS_ONLINE, standby: CAM_STATUS_STANDBY };

// ── API Helpers ──
const apiCall = (api, method, params) =>
    new Promise((resolve, reject) => {
        api.call(method, params, resolve, reject);
    });

const apiMultiCall = (api, calls) =>
    new Promise((resolve, reject) => {
        api.multiCall(calls, resolve, reject);
    });

const getSession = (api) =>
    new Promise((resolve) => {
        api.getSession(resolve);
    });

// ══════════════════════════════════════════════════════════════
// Recommendation Engine
// ══════════════════════════════════════════════════════════════
// Tiers (sorted by urgency):
//   1 = All Good         (green)
//   2 = Vehicle Parked   (blue)
//   3 = Check Vehicle    (orange)  — GO device issue, not camera
//   4 = Check Camera     (red)     — camera issue, GO is fine
//   5 = Health Degraded  (purple)  — online but failing health

const deriveRecommendation = (camStatus, cameraHealth, goComm, daysIdle) => {
    const healthLower = (cameraHealth || "").toLowerCase();
    const isHealthBad = healthLower === "unstable" || healthLower === "not working";

    // ── Tier 5: Health Degraded (camera online/standby but health is bad) ──
    if ((camStatus === CAM_STATUS_ONLINE || camStatus === CAM_STATUS_STANDBY) && goComm && isHealthBad) {
        if (healthLower === "not working") return {
            tier: 5, tierKey: "health-degraded",
            label: "Needs Service",
            desc: "Camera is connected but health check reports Not Working. Schedule camera replacement.",
        };
        return {
            tier: 5, tierKey: "health-degraded",
            label: "Health Unstable",
            desc: "Camera is connected but health is degrading. Monitor closely and schedule preventive maintenance.",
        };
    }

    // ── Tier 4: Check Camera (GO communicating, camera offline) ──
    if (camStatus === CAM_STATUS_OFFLINE && goComm) {
        if (healthLower === "not working") return {
            tier: 4, tierKey: "check-camera",
            label: "Camera Not Working",
            desc: "GO device is online but camera is confirmed not functioning. Schedule camera replacement or repair.",
        };
        if (healthLower === "unstable") return {
            tier: 4, tierKey: "check-camera",
            label: "Camera Offline — Unstable",
            desc: "GO device is online but camera is offline with unstable health. Schedule camera inspection.",
        };
        return {
            tier: 4, tierKey: "check-camera",
            label: "Camera Offline",
            desc: "GO device is communicating but camera is offline. Try power cycling the camera or check camera wiring.",
        };
    }

    // ── Tier 3: Check Vehicle (GO offline — camera can't work without it) ──
    if (!goComm) {
        if (daysIdle > 30) return {
            tier: 3, tierKey: "check-vehicle",
            label: "Vehicle Offline 30+ Days",
            desc: "Vehicle has not communicated in over 30 days. Confirm with fleet manager whether vehicle is still active.",
        };
        if (daysIdle > 7) return {
            tier: 3, tierKey: "check-vehicle",
            label: "Vehicle Offline 7+ Days",
            desc: "GO device not communicating for over a week. May need physical inspection of vehicle and GO device.",
        };
        return {
            tier: 3, tierKey: "check-vehicle",
            label: "GO Device Offline",
            desc: "GO device is not communicating. Check cellular coverage or GO device power. Camera will resume when GO reconnects.",
        };
    }

    // ── Tier 2: Vehicle Parked (standby is normal for parked vehicles) ──
    if (camStatus === CAM_STATUS_STANDBY && goComm) {
        if (daysIdle > 30) return {
            tier: 2, tierKey: "vehicle-parked",
            label: "Parked 30+ Days",
            desc: "Vehicle idle over 30 days. Confirm with fleet manager if vehicle is still in service. Camera is in standby.",
        };
        if (daysIdle > 7) return {
            tier: 2, tierKey: "vehicle-parked",
            label: "Parked 7+ Days",
            desc: "Vehicle idle over a week. Camera is in standby and will activate on next trip. Verify vehicle is in service.",
        };
        return {
            tier: 2, tierKey: "vehicle-parked",
            label: "Vehicle Parked",
            desc: "Vehicle is parked and camera is in standby mode. No action needed — camera will activate on next trip.",
        };
    }

    // ── Tier 1: All Good ──
    if (camStatus === CAM_STATUS_ONLINE && goComm) {
        return {
            tier: 1, tierKey: "all-good",
            label: "Operating Normally",
            desc: "Camera and GO device are online and healthy. No action needed.",
        };
    }

    // ── Fallback ──
    return {
        tier: 3, tierKey: "check-vehicle",
        label: "Unknown State",
        desc: "Unable to determine status. Check vehicle and camera connections.",
    };
};

// Tier sort order (highest urgency first in default view)
const TIER_ORDER = { 5: 0, 4: 1, 3: 2, 2: 3, 1: 4 };

// Summary card definitions (by tier)
const CARD_KEYS = ["total", "check-camera", "health-degraded", "check-vehicle", "vehicle-parked", "all-good"];
const CARD_LABELS = {
    total: "Total Cameras",
    "all-good": "All Good",
    "vehicle-parked": "Vehicle Parked",
    "check-vehicle": "Check Vehicle",
    "check-camera": "Check Camera",
    "health-degraded": "Health Degraded",
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

const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

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
    const [cardFilter, setCardFilter] = useState(null);
    const [expandedRow, setExpandedRow] = useState(null);
    const timerRef = useRef(null);
    const countdownRef = useRef(null);

    // ── Fetch all data ──
    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Step 1: Get session info for media-services auth
            // Use Authenticate to get both sessionId AND the correct server path
            const session = await new Promise((resolve) => geotabApi.getSession(resolve));
            const authResult = await apiCall(geotabApi, "Authenticate", {
                userName: session.userName,
                database: session.database,
                sessionId: session.sessionId,
            });

            const sessionId = authResult.credentials.sessionId;

            // Resolve server path from Authenticate response (most reliable),
            // then document.referrer, then fallback
            let serverPath = authResult.path || authResult.credentials.server;
            if (!serverPath && document.referrer) {
                try { serverPath = new URL(document.referrer).hostname; } catch (_) {}
            }
            if (!serverPath) serverPath = "my.geotab.com";
            const mappingsResp = await fetch(MEDIA_SERVICES_URL, {
                headers: {
                    "x-mygeotab-database": session.database,
                    "x-mygeotab-path": serverPath,
                    "x-mygeotab-sessionid": sessionId,
                    "x-mygeotab-username": session.userName,
                },
            });
            if (!mappingsResp.ok) {
                throw new Error(`Camera service returned ${mappingsResp.status}. Try refreshing the page.`);
            }
            const mappings = await mappingsResp.json();

            // Step 3: Batch-fetch Device objects by serial number
            const serials = [...new Set(mappings.map((m) => m.associatedDeviceSerialNumber))];
            const deviceCalls = serials.map((sn) => [
                "Get", { typeName: "Device", search: { serialNumber: sn }, resultsLimit: 1 },
            ]);
            const deviceResults = await apiMultiCall(geotabApi, deviceCalls);

            const deviceBySerial = {};
            const deviceIds = [];
            for (const arr of deviceResults) {
                if (arr && arr[0]) {
                    deviceBySerial[arr[0].serialNumber] = arr[0];
                    deviceIds.push(arr[0].id);
                }
            }

            // Step 4: Batch-fetch DeviceStatusInfo for GO device status + days idle
            const statusCalls = deviceIds.map((id) => [
                "Get", { typeName: "DeviceStatusInfo", search: { deviceSearch: { id } } },
            ]);
            const statusResults = await apiMultiCall(geotabApi, statusCalls);

            const statusByDeviceId = {};
            for (const arr of statusResults) {
                if (arr && arr[0]) {
                    statusByDeviceId[arr[0].device.id] = arr[0];
                }
            }

            // Step 5: Build joined rows with recommendations
            const joined = [];
            for (const mapping of mappings) {
                const device = deviceBySerial[mapping.associatedDeviceSerialNumber];
                const si = device ? statusByDeviceId[device.id] : null;

                // Camera status from media-services
                const camStatusStr = (mapping.deviceStatus || "").toLowerCase();
                const camStatusValue = CAM_STATUS_MAP[camStatusStr] ?? null;

                // Camera health from media-services
                const cameraHealth = mapping.partnerDeviceHealthStatus || "Unknown";

                // GO device communicating status from DeviceStatusInfo
                const goIsCommunicating = si
                    ? (si.isDeviceCommunicating ?? si.isCommunicating ?? null)
                    : null;

                // Days idle from DeviceStatusInfo
                let daysSinceLastMoved = "—";
                let daysSinceLastMovedNum = -1;
                if (si) {
                    if (si.isDriving === true) {
                        daysSinceLastMoved = "0";
                        daysSinceLastMovedNum = 0;
                    } else if (si.currentStateDuration) {
                        const match = String(si.currentStateDuration).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
                        if (match) {
                            const days = parseInt(match[1] || "0", 10);
                            const hours = parseInt(match[2], 10);
                            daysSinceLastMovedNum = days + (hours >= 12 ? 1 : 0);
                            daysSinceLastMoved = daysSinceLastMovedNum === 0 ? "<1" : String(daysSinceLastMovedNum);
                        }
                    } else if (si.dateTime) {
                        const diffMs = Date.now() - new Date(si.dateTime).getTime();
                        if (diffMs > 0) {
                            daysSinceLastMovedNum = Math.floor(diffMs / 86400000);
                            daysSinceLastMoved = daysSinceLastMovedNum === 0 ? "<1" : String(daysSinceLastMovedNum);
                        }
                    }
                }

                // Derive recommendation
                const rec = deriveRecommendation(
                    camStatusValue, cameraHealth, goIsCommunicating, daysSinceLastMovedNum
                );

                joined.push({
                    vehicleName: device ? device.name : mapping.associatedDeviceSerialNumber,
                    tier: rec.tier,
                    tierKey: rec.tierKey,
                    recLabel: rec.label,
                    recDesc: rec.desc,
                    cameraStatus: capitalize(camStatusStr) || "Unknown",
                    cameraHealth,
                    goDeviceStatus: goIsCommunicating === null ? "No Data" : goIsCommunicating ? "Communicating" : "Not Communicating",
                    goSerial: device ? (device.serialNumber || "—") : mapping.associatedDeviceSerialNumber,
                    cameraId: mapping.partnerDeviceId || "—",
                    cameraModel: mapping.partnerMetaData?.DeviceModel || "—",
                    partner: capitalize(mapping.partnerId) || "—",
                    daysSinceLastMoved,
                    daysSinceLastMovedNum,
                    cameraLastSeen: mapping.deviceStatusLastUpdatedAt ? formatTime(mapping.deviceStatusLastUpdatedAt) : "—",
                    goLastContact: si?.dateTime ? formatTime(si.dateTime) : "—",
                    healthLastChecked: mapping.partnerDeviceHealthLastUpdated ? formatTime(mapping.partnerDeviceHealthLastUpdated) : "—",
                    healthErrors: (mapping.partnerDeviceHealthErrors || []).join(", ") || "None",
                });
            }

            // Default sort: highest urgency first
            joined.sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99));

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
        timerRef.current = setInterval(fetchData, REFRESH_INTERVAL_SEC * 1000);
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

    // ── Counts by tier ──
    const counts = {
        total: cameras.length,
        "all-good": cameras.filter((c) => c.tierKey === "all-good").length,
        "vehicle-parked": cameras.filter((c) => c.tierKey === "vehicle-parked").length,
        "check-vehicle": cameras.filter((c) => c.tierKey === "check-vehicle").length,
        "check-camera": cameras.filter((c) => c.tierKey === "check-camera").length,
        "health-degraded": cameras.filter((c) => c.tierKey === "health-degraded").length,
    };

    // ── Filtering ──
    const filtered = cameras.filter((cam) => {
        if (searchText) {
            const q = searchText.toLowerCase();
            if (!cam.vehicleName.toLowerCase().includes(q) &&
                !cam.goSerial.toLowerCase().includes(q) &&
                !cam.cameraId.toLowerCase().includes(q) &&
                !cam.cameraModel.toLowerCase().includes(q) &&
                !cam.recLabel.toLowerCase().includes(q)) return false;
        }
        if (cardFilter && cardFilter !== "total") {
            return cam.tierKey === cardFilter;
        }
        return true;
    });

    const handleCardClick = (key) => {
        setCardFilter(cardFilter === key ? null : key);
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
            if (sortCol === "tier") {
                return sortDir === "asc" ? a.tier - b.tier : b.tier - a.tier;
            }
            if (sortCol === "daysSinceLastMoved") {
                return sortDir === "asc"
                    ? (a.daysSinceLastMovedNum ?? -1) - (b.daysSinceLastMovedNum ?? -1)
                    : (b.daysSinceLastMovedNum ?? -1) - (a.daysSinceLastMovedNum ?? -1);
            }
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
            "Vehicle Name", "Recommendation", "Next Steps",
            "Camera Status", "Camera Health", "GO Device Status",
            "GO Serial", "Camera ID", "Camera Model", "Partner",
            "Days Idle", "Camera Last Seen",
            "GO Last Contact", "Health Last Checked", "Health Errors",
        ];
        const rows = sortedData.map((cam) => [
            cam.vehicleName, cam.recLabel, cam.recDesc,
            cam.cameraStatus, cam.cameraHealth, cam.goDeviceStatus,
            cam.goSerial, cam.cameraId, cam.cameraModel, cam.partner,
            cam.daysSinceLastMoved, cam.cameraLastSeen,
            cam.goLastContact, cam.healthLastChecked, cam.healthErrors,
        ]);

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
        a.href = url;
        a.download = `camera-health-report-${new Date().toISOString().slice(0, 10)}.xls`;
        a.click();
        URL.revokeObjectURL(url);
    };

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
                {CARD_KEYS.map((key) => (
                    <button
                        key={key}
                        className={`chr-card chr-card--${key}${cardFilter === key ? " chr-card--active" : ""}`}
                        onClick={() => handleCardClick(key)}
                    >
                        <div className="chr-card-count">{counts[key]}</div>
                        <div className="chr-card-label">{CARD_LABELS[key]}</div>
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
                    placeholder="Search vehicle, camera ID, model, or serial…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
                <span className="chr-result-count">
                    {filtered.length} of {cameras.length} cameras
                </span>
            </div>

            {/* Data Table */}
            <div className="chr-table-wrap">
                <table className="chr-table">
                    <thead>
                        <tr>
                            <th onClick={() => handleSort("vehicleName")}>Vehicle{sortIndicator("vehicleName")}</th>
                            <th onClick={() => handleSort("tier")}>Status{sortIndicator("tier")}</th>
                            <th className="chr-th-rec">Recommendation</th>
                            <th onClick={() => handleSort("daysSinceLastMoved")}>Days Idle{sortIndicator("daysSinceLastMoved")}</th>
                            <th onClick={() => handleSort("goLastContact")}>GO Last Contact{sortIndicator("goLastContact")}</th>
                            <th className="chr-th-detail">Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && cameras.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="chr-table-empty">Loading camera data…</td>
                            </tr>
                        ) : sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="chr-table-empty">No cameras match the current filters.</td>
                            </tr>
                        ) : (
                            sortedData.map((cam, i) => (
                                <React.Fragment key={i}>
                                    <tr className={`chr-row chr-row--tier-${cam.tier}`}>
                                        <td title={cam.vehicleName} className="chr-col-vehicle">{cam.vehicleName}</td>
                                        <td>
                                            <span className={`chr-tier-badge chr-tier-badge--${cam.tierKey}`}>
                                                {cam.recLabel}
                                            </span>
                                        </td>
                                        <td className="chr-col-rec">{cam.recDesc}</td>
                                        <td className={`chr-days${cam.daysSinceLastMovedNum > 7 ? " chr-days--warn" : ""}`}>
                                            {cam.daysSinceLastMoved}
                                        </td>
                                        <td>{cam.goLastContact}</td>
                                        <td>
                                            <button
                                                className="chr-detail-toggle"
                                                onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                                            >
                                                {expandedRow === i ? "Hide" : "Show"}
                                            </button>
                                        </td>
                                    </tr>
                                    {expandedRow === i && (
                                        <tr className="chr-detail-row">
                                            <td colSpan={6}>
                                                <div className="chr-detail-grid">
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Camera Status</span>
                                                        <span>{cam.cameraStatus}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Camera Health</span>
                                                        <span>{cam.cameraHealth}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">GO Device Status</span>
                                                        <span>{cam.goDeviceStatus}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Camera ID</span>
                                                        <span className="chr-mono">{cam.cameraId}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Camera Model</span>
                                                        <span>{cam.cameraModel}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Partner</span>
                                                        <span>{cam.partner}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">GO Serial</span>
                                                        <span className="chr-mono">{cam.goSerial}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Camera Last Seen</span>
                                                        <span>{cam.cameraLastSeen}</span>
                                                    </div>
                                                    <div className="chr-detail-item">
                                                        <span className="chr-detail-label">Health Last Checked</span>
                                                        <span>{cam.healthLastChecked}</span>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
