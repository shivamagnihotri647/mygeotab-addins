import React, { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

// ── API helpers ───────────────────────────────────────────────────────────────
const apiCall = (api, method, params) =>
  new Promise((res, rej) => api.call(method, params, res, rej));

const apiMultiCall = (api, calls) =>
  new Promise((res, rej) => api.multiCall(calls, res, rej));

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ── Geometry ──────────────────────────────────────────────────────────────────
function circleToPolygon(lat, lon, diameterM, n = 16) {
  const r = diameterM / 2;
  const dlat = r / 111320;
  const dlon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return {
      x: parseFloat((lon + dlon * Math.cos(a)).toFixed(6)),
      y: parseFloat((lat + dlat * Math.sin(a)).toFixed(6)),
    };
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = 100;
const ADD_WINDOW_MS = 6700;  // 900 zones/min — 100 per batch, 6.7s window including API time
const REM_WINDOW_MS = 6000;  // 1000 removes/min — 100 per batch, 6s window including API time
const GET_PAGE_SIZE = 5000;

const ZONE_TYPE  = "ZoneTypeCustomerId";
const FILL_COLOR = { r: 255, g: 69, b: 0, a: 191 };
const ACTIVE_FROM = "1986-01-01T00:00:00.000Z";
const ACTIVE_TO   = "2050-01-01T00:00:00.000Z";

// ── Status badge helper ───────────────────────────────────────────────────────
const Badge = ({ status }) => {
  const map = {
    idle:      { cls: "zum-badge-idle",    label: "Ready" },
    running:   { cls: "zum-badge-running", label: "Running…" },
    done:      { cls: "zum-badge-done",    label: "Done" },
    error:     { cls: "zum-badge-error",   label: "Error" },
    paused:    { cls: "zum-badge-idle",    label: "Paused" },
  };
  const { cls, label } = map[status] || map.idle;
  return <span className={`zum-badge ${cls}`}>{label}</span>;
};

// ── Progress bar ──────────────────────────────────────────────────────────────
const ProgressBar = ({ done, total }) => {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="zum-progress-wrap">
      <div className="zum-progress-bar" style={{ width: `${pct}%` }} />
      <span className="zum-progress-label">{pct.toFixed(1)}%</span>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
export default function ZoneUploadManager({ geotabApi }) {
  // Phase 1 state
  const [p1Status, setP1Status]       = useState("idle");
  const [totalZones, setTotalZones]   = useState(0);
  const [dupGroups, setDupGroups]     = useState([]);   // [{name, ids:[...]}]
  const [delDone, setDelDone]         = useState(0);
  const [delTotal, setDelTotal]       = useState(0);
  const [p1Complete, setP1Complete]   = useState("");
  const [p1Log, setP1Log]             = useState([]);

  // Phase 2 state
  const [fileName, setFileName]       = useState("");
  const [fileRows, setFileRows]       = useState([]);   // parsed xlsx rows
  const [toUpload, setToUpload]       = useState([]);   // rows after dedup
  const [skipCount, setSkipCount]     = useState(0);
  const [p2Status, setP2Status]       = useState("idle");

  // Phase 3 state
  const [p3Status, setP3Status]       = useState("idle");
  const [upDone, setUpDone]           = useState(0);
  const [upErrors, setUpErrors]       = useState([]);
  const [upRate, setUpRate]           = useState(0);
  const [upEta, setUpEta]             = useState(0);
  const [p3Log, setP3Log]             = useState([]);

  // Refs for pause/cancel
  const pauseRef   = useRef(false);
  const cancelRef  = useRef(false);

  // Cached zone name set (populated in phase 1, reused in phase 2)
  const existingNamesRef = useRef(new Set());

  const addLog = (setter, msg, type = "info") =>
    setter((prev) => [...prev.slice(-199), { msg, type, t: new Date().toLocaleTimeString() }]);

  // ── Phase 1: Scan & dedup ─────────────────────────────────────────────────
  const scanDuplicates = useCallback(async () => {
    setP1Status("running");
    setP1Log([]);
    setDupGroups([]);
    existingNamesRef.current = new Set();
    addLog(setP1Log, "Fetching all zones from Geotab…");

    try {
      const nameMap = {};   // name → [id, ...]
      let page = 0;
      let fetched = 0;

      let fromVersion = "0";
      while (true) {
        const feed = await apiCall(geotabApi, "GetFeed", {
          typeName: "Zone",
          fromVersion,
          resultsLimit: GET_PAGE_SIZE,
        });

        const zones = feed.data || [];
        fromVersion = feed.toVersion;

        for (const z of zones) {
          const name = (z.name || "").trim();
          if (!name) continue;
          existingNamesRef.current.add(name);
          if (!nameMap[name]) nameMap[name] = [];
          nameMap[name].push(z.id);
        }

        fetched += zones.length;
        page++;
        addLog(setP1Log, `Page ${page}: ${fetched.toLocaleString()} zones fetched…`);
        setTotalZones(fetched);

        // GetFeed returns fewer than resultsLimit when all records are exhausted
        if (zones.length < GET_PAGE_SIZE) break;
        await delay(300); // 200 GetFeed/min limit → 1 per 300ms max
      }

      // Find duplicates
      const dups = Object.entries(nameMap)
        .filter(([, ids]) => ids.length > 1)
        .map(([name, ids]) => ({ name, ids }));

      setDupGroups(dups);
      const dupZoneCount = dups.reduce((acc, d) => acc + d.ids.length - 1, 0);
      addLog(
        setP1Log,
        `Scan complete: ${fetched.toLocaleString()} zones, ${dups.length.toLocaleString()} names with duplicates (${dupZoneCount.toLocaleString()} zones to delete).`,
        dups.length > 0 ? "warn" : "info"
      );
      setP1Status("done");
    } catch (err) {
      addLog(setP1Log, `Error: ${err.message || err}`, "error");
      setP1Status("error");
    }
  }, [geotabApi]);

  const deleteDuplicates = useCallback(async () => {
    const toDelete = dupGroups.flatMap(({ ids }) => ids.slice(1)); // keep first
    if (toDelete.length === 0) return;

    setP1Status("running");
    setDelDone(0);
    setDelTotal(toDelete.length);
    setP1Complete("");
    addLog(setP1Log, `Deleting ${toDelete.length.toLocaleString()} duplicate zones…`);

    let done = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      const calls = batch.map((id) => ["Remove", { typeName: "Zone", entity: { id } }]);
      const t0 = Date.now();
      try {
        await apiMultiCall(geotabApi, calls);
        done += batch.length;
        setDelDone(done);
        addLog(setP1Log, `Deleted ${done.toLocaleString()} / ${toDelete.length.toLocaleString()}…`);
      } catch (err) {
        addLog(setP1Log, `Batch error: ${err.message || err}`, "error");
      }
      // Sleep only the remaining time in the 6s window so API call time counts toward the window
      if (i + BATCH_SIZE < toDelete.length) {
        const elapsed = Date.now() - t0;
        const remaining = REM_WINDOW_MS - elapsed;
        if (remaining > 0) await delay(remaining);
      }
    }

    addLog(setP1Log, `Done. ${done.toLocaleString()} duplicates removed.`, "success");
    setP1Complete(`✓ Complete — ${done.toLocaleString()} duplicate zones deleted.`);
    setDupGroups([]);
    setP1Status("done");
  }, [geotabApi, dupGroups]);

  // ── Phase 2: File picker & cross-check ───────────────────────────────────
  const handleFile = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setP2Status("running");
    setFileName(file.name);
    setFileRows([]);
    setToUpload([]);
    setSkipCount(0);

    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // Skip header row, filter rows that have name + lat + lon
      const rows = raw.slice(1).filter(
        (r) => r[0] && r[1] != null && r[2] != null
      );
      setFileRows(rows);

      // Cross-check against existing zones (populated in phase 1)
      const existing = existingNamesRef.current;
      const upload   = rows.filter((r) => !existing.has(String(r[0]).trim()));
      const skip     = rows.length - upload.length;

      setToUpload(upload);
      setSkipCount(skip);
      setP2Status("done");
    } catch (err) {
      setP2Status("error");
    }
    // Reset input so same file can be re-selected
    e.target.value = "";
  }, []);

  // ── Phase 3: Upload ───────────────────────────────────────────────────────
  const startUpload = useCallback(async () => {
    if (toUpload.length === 0) return;
    setP3Status("running");
    setUpDone(0);
    setUpErrors([]);
    setP3Log([]);
    pauseRef.current  = false;
    cancelRef.current = false;

    const startTime = Date.now();
    let done = 0;
    const total = toUpload.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      // Pause / cancel check
      while (pauseRef.current && !cancelRef.current) await delay(500);
      if (cancelRef.current) {
        addLog(setP3Log, "Upload cancelled.", "warn");
        setP3Status("paused");
        return;
      }

      const batchT0 = Date.now();
      const batch = toUpload.slice(i, i + BATCH_SIZE);
      const calls = batch.map((row) => {
        const [name, lat, lon, ref, comments, diameter] = row;
        const entity = {
          name: String(name).trim(),
          mustIdentifyStops: true,
          displayed: true,
          activeFrom: ACTIVE_FROM,
          activeTo: ACTIVE_TO,
          zoneTypes: [ZONE_TYPE],
          fillColor: FILL_COLOR,
          points: circleToPolygon(
            parseFloat(lat),
            parseFloat(lon),
            parseFloat(diameter) || 250
          ),
          groups: [{ id: "GroupCompanyId" }],
        };
        if (ref)      entity.externalReference = String(ref);
        if (comments) entity.comment = String(comments);
        return ["Add", { typeName: "Zone", entity }];
      });

      try {
        const results = await apiMultiCall(geotabApi, calls);
        const batchErrors = [];
        (results || []).forEach((r, idx) => {
          if (r && r.error) batchErrors.push(`${batch[idx][0]}: ${r.error.message || r.error}`);
        });
        done += batch.length - batchErrors.length;
        setUpDone(done);
        if (batchErrors.length > 0) {
          setUpErrors((prev) => [...prev, ...batchErrors]);
          addLog(setP3Log, `Batch ${Math.ceil(i / BATCH_SIZE) + 1}: ${batchErrors.length} error(s)`, "error");
        } else {
          addLog(setP3Log, `Batch ${Math.ceil(i / BATCH_SIZE) + 1}: ${batch.length} zones uploaded ✓`);
        }
      } catch (err) {
        addLog(setP3Log, `Batch error: ${err.message || err}`, "error");
      }

      // Update rate & ETA
      const elapsed = (Date.now() - startTime) / 1000 / 60; // minutes
      const rate = elapsed > 0 ? done / elapsed : 0;
      const eta  = rate > 0 ? (total - done) / rate : 0;
      setUpRate(Math.round(rate));
      setUpEta(eta.toFixed(1));

      if (i + BATCH_SIZE < total) {
        const batchElapsed = Date.now() - batchT0;
        const remaining = ADD_WINDOW_MS - batchElapsed;
        if (remaining > 0) await delay(remaining);
      }
    }

    addLog(setP3Log, `Upload complete: ${done.toLocaleString()} zones added.`, "success");
    setP3Status("done");
  }, [geotabApi, toUpload]);

  const togglePause = () => {
    if (p3Status === "running") {
      pauseRef.current = true;
      setP3Status("paused");
    } else if (p3Status === "paused") {
      pauseRef.current = false;
      setP3Status("running");
    }
  };

  const cancelUpload = () => {
    cancelRef.current = true;
    pauseRef.current  = false;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const dupZoneCount = dupGroups.reduce((acc, d) => acc + d.ids.length - 1, 0);

  return (
    <div className="zum-container">
      <div className="zum-header">
        <h1 className="zum-title">Zone Upload Manager</h1>
        <p className="zum-subtitle">Deduplicate, validate, and bulk upload zones to Geotab</p>
      </div>

      {/* ── Phase 1 ── */}
      <div className="zum-card">
        <div className="zum-card-header">
          <span className="zum-phase-label">Phase 1</span>
          <span className="zum-card-title">Scan &amp; Remove Duplicates</span>
          <Badge status={p1Status} />
        </div>
        <div className="zum-card-body">
          {totalZones > 0 && (
            <div className="zum-stats-row">
              <div className="zum-stat">
                <span className="zum-stat-value">{totalZones.toLocaleString()}</span>
                <span className="zum-stat-label">Total zones in Geotab</span>
              </div>
              <div className="zum-stat">
                <span className="zum-stat-value zum-stat-warn">{dupGroups.length.toLocaleString()}</span>
                <span className="zum-stat-label">Duplicate names</span>
              </div>
              <div className="zum-stat">
                <span className="zum-stat-value zum-stat-warn">{dupZoneCount.toLocaleString()}</span>
                <span className="zum-stat-label">Zones to delete</span>
              </div>
            </div>
          )}
          <div className="zum-btn-row">
            <button
              className="zum-btn zum-btn-primary"
              onClick={scanDuplicates}
              disabled={p1Status === "running"}
            >
              {p1Status === "running" ? "Scanning…" : "Scan for Duplicates"}
            </button>
            {dupZoneCount > 0 && (
              <button
                className="zum-btn zum-btn-danger"
                onClick={deleteDuplicates}
                disabled={p1Status === "running"}
              >
                Delete {dupZoneCount.toLocaleString()} Duplicates
              </button>
            )}
          </div>
          {delTotal > 0 && (
            <ProgressBar done={delDone} total={delTotal} />
          )}
          {p1Complete && (
            <div className="zum-complete-msg">{p1Complete}</div>
          )}
          <LogArea logs={p1Log} />
        </div>
      </div>

      {/* ── Phase 2 ── */}
      <div className="zum-card">
        <div className="zum-card-header">
          <span className="zum-phase-label">Phase 2</span>
          <span className="zum-card-title">Load Upload File</span>
          <Badge status={p2Status} />
        </div>
        <div className="zum-card-body">
          <div className="zum-file-row">
            <label className="zum-btn zum-btn-secondary" htmlFor="zum-file-input">
              Browse .xlsx
            </label>
            <input
              id="zum-file-input"
              type="file"
              accept=".xlsx"
              className="zum-file-input-hidden"
              onChange={handleFile}
            />
            {fileName && <span className="zum-file-name">{fileName}</span>}
          </div>
          {fileRows.length > 0 && (
            <div className="zum-stats-row">
              <div className="zum-stat">
                <span className="zum-stat-value">{fileRows.length.toLocaleString()}</span>
                <span className="zum-stat-label">Zones in file</span>
              </div>
              <div className="zum-stat">
                <span className="zum-stat-value zum-stat-skip">{skipCount.toLocaleString()}</span>
                <span className="zum-stat-label">Already in Geotab (skip)</span>
              </div>
              <div className="zum-stat">
                <span className="zum-stat-value zum-stat-good">{toUpload.length.toLocaleString()}</span>
                <span className="zum-stat-label">To upload</span>
              </div>
            </div>
          )}
          {existingNamesRef.current.size === 0 && (
            <p className="zum-hint">Run Phase 1 first so the file can be cross-checked against existing zones.</p>
          )}
        </div>
      </div>

      {/* ── Phase 3 ── */}
      <div className="zum-card">
        <div className="zum-card-header">
          <span className="zum-phase-label">Phase 3</span>
          <span className="zum-card-title">Upload Zones</span>
          <Badge status={p3Status} />
        </div>
        <div className="zum-card-body">
          {toUpload.length > 0 && (
            <>
              <ProgressBar done={upDone} total={toUpload.length} />
              <div className="zum-stats-row">
                <div className="zum-stat">
                  <span className="zum-stat-value">{upDone.toLocaleString()}</span>
                  <span className="zum-stat-label">Uploaded</span>
                </div>
                <div className="zum-stat">
                  <span className="zum-stat-value">{(toUpload.length - upDone).toLocaleString()}</span>
                  <span className="zum-stat-label">Remaining</span>
                </div>
                <div className="zum-stat">
                  <span className="zum-stat-value">{upRate.toLocaleString()}</span>
                  <span className="zum-stat-label">Zones/min</span>
                </div>
                <div className="zum-stat">
                  <span className="zum-stat-value">{upEta}</span>
                  <span className="zum-stat-label">ETA (min)</span>
                </div>
              </div>
            </>
          )}
          <div className="zum-btn-row">
            <button
              className="zum-btn zum-btn-primary"
              onClick={startUpload}
              disabled={toUpload.length === 0 || p3Status === "running" || p3Status === "done"}
            >
              {p3Status === "done" ? "Upload Complete" : "Start Upload"}
            </button>
            {(p3Status === "running" || p3Status === "paused") && (
              <>
                <button className="zum-btn zum-btn-secondary" onClick={togglePause}>
                  {p3Status === "paused" ? "Resume" : "Pause"}
                </button>
                <button className="zum-btn zum-btn-danger" onClick={cancelUpload}>
                  Cancel
                </button>
              </>
            )}
          </div>
          {upErrors.length > 0 && (
            <p className="zum-hint zum-hint-error">{upErrors.length} zone(s) failed — see log</p>
          )}
          <LogArea logs={p3Log} />
        </div>
      </div>
    </div>
  );
}

// ── Log area sub-component ────────────────────────────────────────────────────
function LogArea({ logs }) {
  if (logs.length === 0) return null;
  return (
    <div className="zum-log">
      {logs.map((l, i) => (
        <div key={i} className={`zum-log-line zum-log-${l.type}`}>
          <span className="zum-log-time">{l.t}</span> {l.msg}
        </div>
      ))}
    </div>
  );
}
