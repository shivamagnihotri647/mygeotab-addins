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

function computeCenter(points) {
  if (!points || points.length === 0) return { lat: 0, lon: 0 };
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.y, lon: acc.lon + p.x }), { lat: 0, lon: 0 });
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ADD_BATCH     = 100;   // zones per Add multiCall
const REM_BATCH     = 25;    // zones per Remove multiCall
const REM_CONCUR    = 20;    // concurrent Remove multiCalls (20×25=500 removes/round, under 1000/min)
const SET_BATCH     = 100;   // zones per Set multiCall
const ADD_WINDOW_MS = 6700;  // 900 zones/min — 100 per batch, 6.7s window including API time
const SET_WINDOW_MS = 30000; // 200 Set/min — 100 per batch, 30s window
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
  const [masterFileName, setMasterFileName] = useState("");
  const [masterMatchCount, setMasterMatchCount] = useState(0);
  const masterNamesRef = useRef(new Set()); // names from master xlsx

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

  // Phase 4 state
  const [p4Status, setP4Status]       = useState("idle");
  const [p4FileName, setP4FileName]   = useState("");
  const [p4Diameter, setP4Diameter]   = useState(100);
  const [p4Total, setP4Total]         = useState(0);
  const [p4Done, setP4Done]           = useState(0);
  const [p4Rate, setP4Rate]           = useState(0);
  const [p4Eta, setP4Eta]             = useState(0);
  const [p4Log, setP4Log]             = useState([]);
  const p4NamesRef = useRef(new Set()); // names from the reference xlsx

  // Refs for pause/cancel
  const pauseRef   = useRef(false);
  const cancelRef  = useRef(false);
  const p4CancelRef = useRef(false);

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
    const delStart = Date.now();
    // Fire REM_CONCUR batches in parallel per round, then move to next round
    for (let i = 0; i < toDelete.length; i += REM_BATCH * REM_CONCUR) {
      const roundBatches = [];
      for (let j = 0; j < REM_CONCUR; j++) {
        const start = i + j * REM_BATCH;
        if (start >= toDelete.length) break;
        const batch = toDelete.slice(start, start + REM_BATCH);
        roundBatches.push(batch);
      }
      // Fire all batches in this round concurrently
      const results = await Promise.allSettled(
        roundBatches.map((batch) =>
          apiMultiCall(geotabApi, batch.map((id) => ["Remove", { typeName: "Zone", entity: { id } }]))
        )
      );
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          done += roundBatches[idx].length;
        } else {
          addLog(setP1Log, `Batch error: ${r.reason?.message || r.reason}`, "error");
        }
      });
      setDelDone(done);
      const elapsedMin = (Date.now() - delStart) / 60000;
      const rate = elapsedMin > 0 ? Math.round(done / elapsedMin) : 0;
      const eta  = rate > 0 ? ((toDelete.length - done) / rate).toFixed(1) : "?";
      addLog(setP1Log, `Deleted ${done.toLocaleString()} / ${toDelete.length.toLocaleString()} — ${rate}/min, ETA ${eta} min`);
    }

    addLog(setP1Log, `Done. ${done.toLocaleString()} duplicates removed.`, "success");
    setP1Complete(`✓ Complete — ${done.toLocaleString()} duplicate zones deleted.`);
    setDupGroups([]);
    setP1Status("done");
  }, [geotabApi, dupGroups]);

  const handleMasterFile = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setMasterFileName(file.name);
    setMasterMatchCount(0);
    masterNamesRef.current = new Set();
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });
      raw.slice(1).forEach((r) => {
        if (r[0]) masterNamesRef.current.add(String(r[0]).trim());
      });
      addLog(setP1Log, `Master list loaded: ${masterNamesRef.current.size.toLocaleString()} zone names.`);
    } catch (err) {
      addLog(setP1Log, `Error reading file: ${err.message || err}`, "error");
    }
    e.target.value = "";
  }, []);

  const deleteFromMaster = useCallback(async () => {
    const targetNames = masterNamesRef.current;
    if (targetNames.size === 0) return;

    setP1Status("running");
    setDelDone(0);
    setDelTotal(0);
    setMasterMatchCount(0);
    setP1Complete("");
    addLog(setP1Log, "Scanning Geotab zones to find master-list matches…");

    try {
      // Collect IDs of zones whose names are in the master list
      const toDelete = [];
      let fromVersion = "0";
      let fetched = 0;
      while (true) {
        const feed = await apiCall(geotabApi, "GetFeed", {
          typeName: "Zone",
          fromVersion,
          resultsLimit: GET_PAGE_SIZE,
        });
        const zones = feed.data || [];
        fromVersion = feed.toVersion;
        for (const z of zones) {
          if (targetNames.has((z.name || "").trim())) toDelete.push(z.id);
        }
        fetched += zones.length;
        addLog(setP1Log, `Scanned ${fetched.toLocaleString()} zones, ${toDelete.length.toLocaleString()} matched…`);
        if (zones.length < GET_PAGE_SIZE) break;
        await delay(300);
      }

      setMasterMatchCount(toDelete.length);

      if (toDelete.length === 0) {
        addLog(setP1Log, "No matching zones found in Geotab.", "warn");
        setP1Status("done");
        return;
      }

      setDelTotal(toDelete.length);
      addLog(setP1Log, `Deleting ${toDelete.length.toLocaleString()} matched zones…`);

      let done = 0;
      const delStart = Date.now();
      for (let i = 0; i < toDelete.length; i += REM_BATCH * REM_CONCUR) {
        const roundBatches = [];
        for (let j = 0; j < REM_CONCUR; j++) {
          const start = i + j * REM_BATCH;
          if (start >= toDelete.length) break;
          roundBatches.push(toDelete.slice(start, start + REM_BATCH));
        }
        const results = await Promise.allSettled(
          roundBatches.map((batch) =>
            apiMultiCall(geotabApi, batch.map((id) => ["Remove", { typeName: "Zone", entity: { id } }]))
          )
        );
        results.forEach((r, idx) => {
          if (r.status === "fulfilled") done += roundBatches[idx].length;
          else addLog(setP1Log, `Batch error: ${r.reason?.message || r.reason}`, "error");
        });
        setDelDone(done);
        const elapsedMin = (Date.now() - delStart) / 60000;
        const rate = elapsedMin > 0 ? Math.round(done / elapsedMin) : 0;
        const eta  = rate > 0 ? ((toDelete.length - done) / rate).toFixed(1) : "?";
        addLog(setP1Log, `Deleted ${done.toLocaleString()} / ${toDelete.length.toLocaleString()} — ${rate}/min, ETA ${eta} min`);
      }

      addLog(setP1Log, `Done. ${done.toLocaleString()} zones deleted.`, "success");
      setP1Complete(`✓ Complete — ${done.toLocaleString()} zones from master list deleted.`);
      setDupGroups([]);
      existingNamesRef.current = new Set();
      setP1Status("done");
    } catch (err) {
      addLog(setP1Log, `Error: ${err.message || err}`, "error");
      setP1Status("error");
    }
  }, [geotabApi]);

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

    for (let i = 0; i < total; i += ADD_BATCH) {
      // Pause / cancel check
      while (pauseRef.current && !cancelRef.current) await delay(500);
      if (cancelRef.current) {
        addLog(setP3Log, "Upload cancelled.", "warn");
        setP3Status("paused");
        return;
      }

      const batchT0 = Date.now();
      const batch = toUpload.slice(i, i + ADD_BATCH);
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
            parseFloat(diameter) || 30
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
          addLog(setP3Log, `Batch ${Math.ceil(i / ADD_BATCH) + 1}: ${batchErrors.length} error(s)`, "error");
        } else {
          addLog(setP3Log, `Batch ${Math.ceil(i / ADD_BATCH) + 1}: ${batch.length} zones uploaded ✓`);
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

      if (i + ADD_BATCH < total) {
        const batchElapsed = Date.now() - batchT0;
        const remaining = ADD_WINDOW_MS - batchElapsed;
        if (remaining > 0) await delay(remaining);
      }
    }

    addLog(setP3Log, `Upload complete: ${done.toLocaleString()} zones added.`, "success");
    setP3Status("done");
  }, [geotabApi, toUpload]);

  // ── Phase 4: Resize upload-sourced zones ─────────────────────────────────
  const handleP4File = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setP4FileName(file.name);
    p4NamesRef.current = new Set();
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });
      raw.slice(1).forEach((r) => {
        if (r[0]) p4NamesRef.current.add(String(r[0]).trim());
      });
      addLog(setP4Log, `Loaded ${p4NamesRef.current.size.toLocaleString()} zone names from file.`);
    } catch (err) {
      addLog(setP4Log, `Error reading file: ${err.message || err}`, "error");
    }
    e.target.value = "";
  }, []);

  const startResize = useCallback(async () => {
    const targetNames = p4NamesRef.current;
    if (targetNames.size === 0) return;
    if (!p4Diameter || p4Diameter <= 0) return;

    setP4Status("running");
    setP4Done(0);
    setP4Total(0);
    setP4Log([]);
    p4CancelRef.current = false;
    addLog(setP4Log, `Fetching all zones from Geotab to find upload-sourced zones…`);

    try {
      // Step 1 — fetch all zones with lat/lon/points data
      const zoneMap = {}; // name → full zone entity (last seen wins)
      let fromVersion = "0";
      let fetched = 0;
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
          if (name && targetNames.has(name)) {
            zoneMap[name] = z;
          }
        }
        fetched += zones.length;
        addLog(setP4Log, `Scanned ${fetched.toLocaleString()} zones…`);
        if (zones.length < GET_PAGE_SIZE) break;
        await delay(300);
      }

      const toResize = Object.values(zoneMap);
      addLog(setP4Log, `Found ${toResize.length.toLocaleString()} upload-sourced zones to resize to ${p4Diameter}m.`);
      setP4Total(toResize.length);

      if (toResize.length === 0) {
        setP4Status("done");
        return;
      }

      // Step 2 — Set each zone with new polygon
      let done = 0;
      const startTime = Date.now();

      for (let i = 0; i < toResize.length; i += SET_BATCH) {
        if (p4CancelRef.current) {
          addLog(setP4Log, "Resize cancelled.", "warn");
          setP4Status("paused");
          return;
        }

        const batchT0 = Date.now();
        const batch = toResize.slice(i, i + SET_BATCH);
        const calls = batch.map((z) => {
          const center = computeCenter(z.points || []);
          const updated = {
            ...z,
            points: circleToPolygon(center.lat, center.lon, parseFloat(p4Diameter)),
          };
          return ["Set", { typeName: "Zone", entity: updated }];
        });

        try {
          await apiMultiCall(geotabApi, calls);
          done += batch.length;
          setP4Done(done);
          addLog(setP4Log, `Batch ${Math.ceil(i / SET_BATCH) + 1}: ${batch.length} zones resized ✓`);
        } catch (err) {
          addLog(setP4Log, `Batch error: ${err.message || err}`, "error");
        }

        const elapsed = (Date.now() - startTime) / 1000 / 60;
        const rate = elapsed > 0 ? done / elapsed : 0;
        const eta  = rate > 0 ? (toResize.length - done) / rate : 0;
        setP4Rate(Math.round(rate));
        setP4Eta(eta.toFixed(1));

        if (i + SET_BATCH < toResize.length) {
          const batchElapsed = Date.now() - batchT0;
          const remaining = SET_WINDOW_MS - batchElapsed;
          if (remaining > 0) await delay(remaining);
        }
      }

      addLog(setP4Log, `Resize complete: ${done.toLocaleString()} zones updated to ${p4Diameter}m diameter.`, "success");
      setP4Status("done");
    } catch (err) {
      addLog(setP4Log, `Error: ${err.message || err}`, "error");
      setP4Status("error");
    }
  }, [geotabApi, p4Diameter]);

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
          <span className="zum-card-title">Delete Zones from Master List</span>
          <Badge status={p1Status} />
        </div>
        <div className="zum-card-body">
          <p className="zum-hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Load your master .xlsx to delete only zones whose names appear in the file — manually created zones are left untouched.
          </p>
          <div className="zum-file-row">
            <label className="zum-btn zum-btn-secondary" htmlFor="zum-master-file-input">
              Browse master .xlsx
            </label>
            <input
              id="zum-master-file-input"
              type="file"
              accept=".xlsx"
              className="zum-file-input-hidden"
              onChange={handleMasterFile}
            />
            {masterFileName && <span className="zum-file-name">{masterFileName}</span>}
          </div>
          {masterNamesRef.current.size > 0 && (
            <div className="zum-stats-row">
              <div className="zum-stat">
                <span className="zum-stat-value">{masterNamesRef.current.size.toLocaleString()}</span>
                <span className="zum-stat-label">Names in master list</span>
              </div>
              {masterMatchCount > 0 && (
                <div className="zum-stat">
                  <span className="zum-stat-value zum-stat-warn">{masterMatchCount.toLocaleString()}</span>
                  <span className="zum-stat-label">Matched in Geotab</span>
                </div>
              )}
            </div>
          )}
          <div className="zum-btn-row">
            <button
              className="zum-btn zum-btn-danger"
              onClick={deleteFromMaster}
              disabled={masterNamesRef.current.size === 0 || p1Status === "running"}
            >
              {p1Status === "running" ? "Deleting…" : "Delete Zones from Master List"}
            </button>
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
      {/* ── Phase 4 ── */}
      <div className="zum-card">
        <div className="zum-card-header">
          <span className="zum-phase-label">Phase 4</span>
          <span className="zum-card-title">Resize Upload-Sourced Zones</span>
          <Badge status={p4Status} />
        </div>
        <div className="zum-card-body">
          <p className="zum-hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Loads your upload .xlsx, matches zone names in Geotab, and resizes only those zones — leaving manually created zones untouched.
          </p>
          <div className="zum-file-row">
            <label className="zum-btn zum-btn-secondary" htmlFor="zum-p4-file-input">
              Browse upload .xlsx
            </label>
            <input
              id="zum-p4-file-input"
              type="file"
              accept=".xlsx"
              className="zum-file-input-hidden"
              onChange={handleP4File}
            />
            {p4FileName && <span className="zum-file-name">{p4FileName}</span>}
          </div>
          {p4NamesRef.current.size > 0 && (
            <div className="zum-stats-row">
              <div className="zum-stat">
                <span className="zum-stat-value">{p4NamesRef.current.size.toLocaleString()}</span>
                <span className="zum-stat-label">Names in file</span>
              </div>
              {p4Total > 0 && (
                <>
                  <div className="zum-stat">
                    <span className="zum-stat-value zum-stat-good">{p4Done.toLocaleString()}</span>
                    <span className="zum-stat-label">Resized</span>
                  </div>
                  <div className="zum-stat">
                    <span className="zum-stat-value">{p4Rate.toLocaleString()}</span>
                    <span className="zum-stat-label">Zones/min</span>
                  </div>
                  <div className="zum-stat">
                    <span className="zum-stat-value">{p4Eta}</span>
                    <span className="zum-stat-label">ETA (min)</span>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="zum-btn-row" style={{ alignItems: "center" }}>
            <label style={{ fontSize: 13, marginRight: 4 }}>Diameter (m):</label>
            <input
              type="number"
              min="10"
              max="10000"
              value={p4Diameter}
              onChange={(e) => setP4Diameter(Number(e.target.value))}
              style={{ width: 80, padding: "6px 8px", fontSize: 13, border: "1px solid #dde3ec", borderRadius: 4 }}
              disabled={p4Status === "running"}
            />
            <button
              className="zum-btn zum-btn-primary"
              onClick={startResize}
              disabled={p4NamesRef.current.size === 0 || p4Status === "running" || p4Status === "done"}
              style={{ marginLeft: 8 }}
            >
              {p4Status === "done" ? "Resize Complete" : "Start Resize"}
            </button>
            {p4Status === "running" && (
              <button className="zum-btn zum-btn-danger" onClick={() => { p4CancelRef.current = true; }}>
                Cancel
              </button>
            )}
          </div>
          {p4Total > 0 && (
            <ProgressBar done={p4Done} total={p4Total} />
          )}
          <LogArea logs={p4Log} />
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
