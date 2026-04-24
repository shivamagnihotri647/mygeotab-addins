/**
 * BulkUserUpload — React MyGeotab Add-In
 *
 * Bulk-creates users in a MyGeotab database from a CSV file.
 * Features a template builder for selecting optional User fields,
 * drag-and-drop CSV upload, batched multiCall with rate limiting,
 * HOS ruleset assignment, group name resolution, NFC key support,
 * and results export.
 *
 * Modeled after the Geotab SDK importUsers.html reference sample.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ── Constants ──
// Add:User rate limit is 250 calls/min (~4/sec).
// Batch size 4 with 1s delay = 240 calls/min (safe margin).
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 1000;

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
            "nfcKey",
            "customNfcKey",
            "licenseNumber",
            "licenseProvince",
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
            "sendWelcomeEmail",
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
    "sendWelcomeEmail",
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

// Fields that should NOT be set on the User entity directly
// (hosRuleSet is added as a separate UserHosRuleSet entity after user creation)
const NON_ENTITY_FIELDS = new Set(["hosRuleSet", "nfcKey", "customNfcKey"]);

const DEFAULT_CONFIG = {
    timeZoneId: "America/Chicago",
    fuelEconomyUnit: "MPGUS",
    isMetric: false,
    isDriver: true,
    password: "",
    companyGroups: "GroupCompanyId",
    securityGroups: "GroupDriveUserSecurityId",
    changePassword: false,
    delayVerificationEmail: false,
    featurePreview: "Disabled",
    isYardMoveEnabled: false,
    isPersonalConveyanceEnabled: false,
};

// ── Field Reference Metadata ──
const FIELD_REFERENCE = [
    // Mandatory fields
    { field: "name", label: "Username", mandatory: true, type: "text", format: "email or unique string", default: "(required)", description: "Unique login username (usually email)" },
    { field: "firstName", label: "First Name", mandatory: true, type: "text", format: "text", default: "(required)", description: "User's first name" },
    { field: "lastName", label: "Last Name", mandatory: true, type: "text", format: "text", default: "(required)", description: "User's last name" },
    { field: "password", label: "Password", mandatory: true, type: "text", format: "8+ chars, mixed case/digits/symbols", default: "auto-generated", description: "Account password; auto-generated if empty and changePassword is on" },
    { field: "companyGroups", label: "Company Groups", mandatory: true, type: "group", format: "pipe-separated names or IDs", default: "GroupCompanyId", description: "Organization groups the user belongs to" },
    { field: "securityGroups", label: "Security Groups", mandatory: true, type: "group", format: "pipe-separated IDs", default: "GroupDriveUserSecurityId", description: "Security clearance groups (e.g. GroupDriveUserSecurityId)" },
    { field: "featurePreview", label: "Feature Preview", mandatory: true, type: "select", format: "Disabled | Enabled", default: "Disabled", description: "Whether the user sees preview/beta features" },
    { field: "isYardMoveEnabled", label: "Yard Move Enabled", mandatory: true, type: "boolean", format: "true/false", default: "false", description: "Allow driver to log yard move duty status" },
    { field: "isPersonalConveyanceEnabled", label: "Personal Conveyance", mandatory: true, type: "boolean", format: "true/false", default: "false", description: "Allow driver to log personal conveyance duty status" },
    { field: "timeZoneId", label: "Time Zone", mandatory: true, type: "select", format: "IANA tz (e.g. America/Chicago)", default: "America/Chicago", description: "User's time zone for reports and display" },
    { field: "fuelEconomyUnit", label: "Fuel Economy Unit", mandatory: true, type: "select", format: "MPGUS | MPGImperial | LitersPer100Km | KmPerLiter", default: "MPGUS", description: "Unit system for fuel economy values" },
    { field: "isMetric", label: "Use Metric", mandatory: true, type: "boolean", format: "true/false", default: "false", description: "Display distances/speeds in metric units" },
    // Identity & Personal
    { field: "employeeNo", label: "Employee No", mandatory: false, type: "text", format: "text", default: "(none)", description: "Employee number for payroll/HR integration" },
    { field: "comment", label: "Comment", mandatory: false, type: "text", format: "text", default: "(none)", description: "Free-text note about the user" },
    { field: "designation", label: "Designation", mandatory: false, type: "text", format: "text", default: "(none)", description: "Job title or designation" },
    { field: "phoneNumber", label: "Phone Number", mandatory: false, type: "text", format: "digits", default: "(none)", description: "User's phone number" },
    { field: "phoneNumberExtension", label: "Phone Extension", mandatory: false, type: "text", format: "digits", default: "(none)", description: "Phone number extension" },
    { field: "companyName", label: "Company Name", mandatory: false, type: "text", format: "text", default: "(none)", description: "Company or organization name" },
    { field: "companyAddress", label: "Company Address", mandatory: false, type: "text", format: "text", default: "(none)", description: "Company street address" },
    { field: "countryCode", label: "Country Code", mandatory: false, type: "text", format: "ISO 3166-1 (e.g. US, CA)", default: "(none)", description: "Two-letter country code" },
    // Driver / HOS
    { field: "isDriver", label: "Is Driver", mandatory: false, type: "boolean", format: "true/false", default: "true", description: "Whether the user is a driver (auto-set if NFC/license present)" },
    { field: "hosRuleSet", label: "HOS Rule Set", mandatory: false, type: "text", format: "HOS ruleset ID string", default: "(none)", description: "Hours of Service ruleset ID (added as UserHosRuleSet after creation)" },
    { field: "nfcKey", label: "NFC Key", mandatory: false, type: "text", format: "NFC serial number", default: "(none)", description: "NFC driver key serial number" },
    { field: "customNfcKey", label: "Custom NFC Key", mandatory: false, type: "text", format: "numeric (< 72057594037927940)", default: "(none)", description: "Custom NFC driver key number" },
    { field: "licenseNumber", label: "License Number", mandatory: false, type: "text", format: "text", default: "(none)", description: "Driver's license number" },
    { field: "licenseProvince", label: "License Province", mandatory: false, type: "text", format: "state/province code", default: "(none)", description: "Province or state that issued the license" },
    { field: "authorityName", label: "Authority Name", mandatory: false, type: "text", format: "text", default: "(none)", description: "Carrier authority name (FMCSA)" },
    { field: "authorityAddress", label: "Authority Address", mandatory: false, type: "text", format: "text", default: "(none)", description: "Carrier authority address" },
    { field: "carrierNumber", label: "Carrier Number", mandatory: false, type: "text", format: "text", default: "(none)", description: "DOT or carrier number" },
    { field: "isAdverseDrivingEnabled", label: "Adverse Driving", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Enable adverse driving conditions exception" },
    { field: "isExemptHOSEnabled", label: "Exempt HOS", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Enable short-haul HOS exemption" },
    { field: "maxPCDistancePerDay", label: "Max PC Distance/Day", mandatory: false, type: "number", format: "numeric (meters)", default: "(none)", description: "Maximum personal conveyance distance per day in meters" },
    // Groups
    { field: "reportGroups", label: "Report Groups", mandatory: false, type: "group", format: "pipe-separated names or IDs", default: "(none)", description: "Groups used for report scoping" },
    { field: "privateUserGroups", label: "Private User Groups", mandatory: false, type: "group", format: "pipe-separated names or IDs", default: "(none)", description: "Groups for private user data access" },
    // Account
    { field: "userAuthenticationType", label: "Auth Type", mandatory: false, type: "text", format: "BasicAuthentication | MyAdmin | SAML", default: "BasicAuthentication", description: "Authentication method for the user" },
    { field: "changePassword", label: "Change Password", mandatory: false, type: "boolean", format: "true/false", default: "false", description: "Force user to change password on next login" },
    { field: "sendWelcomeEmail", label: "Send Welcome Email", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Send a welcome/verification email on creation" },
    { field: "activeFrom", label: "Active From", mandatory: false, type: "text", format: "ISO 8601 datetime", default: "now", description: "Date/time when the user account becomes active" },
    { field: "activeTo", label: "Active To", mandatory: false, type: "text", format: "ISO 8601 datetime", default: "2050-01-01", description: "Date/time when the user account expires" },
    { field: "isEmailReportEnabled", label: "Email Reports", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Enable scheduled email reports" },
    { field: "isNewsEnabled", label: "News Enabled", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Show Geotab news feed to the user" },
    { field: "isLabsEnabled", label: "Labs Enabled", mandatory: false, type: "boolean", format: "true/false", default: "(none)", description: "Enable access to Geotab Labs features" },
];

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

/** Trigger browser download of an Excel workbook */
function downloadXlsx(worksheetData, filename, sheetName = "Sheet1") {
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbOut], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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
// Password Generation
// ══════════════════════════════════════════════════════════════

/** Generate a temporary random password that meets MyGeotab complexity requirements */
function generateTemporaryPassword() {
    const length = 16;
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "Aa1!"; // Ensure complexity requirements met
    const randomValues = new Uint32Array(length - 4);
    window.crypto.getRandomValues(randomValues);
    for (let i = 0; i < randomValues.length; i++) {
        password += charset.charAt(randomValues[i] % charset.length);
    }
    // Shuffle using crypto
    const arr = password.split("");
    const shuffleRandom = new Uint32Array(arr.length);
    window.crypto.getRandomValues(shuffleRandom);
    const indexed = arr.map((ch, i) => ({ ch, r: shuffleRandom[i] }));
    indexed.sort((a, b) => a.r - b.r);
    return indexed.map((x) => x.ch).join("");
}

// ══════════════════════════════════════════════════════════════
// Error Message Parsing
// ══════════════════════════════════════════════════════════════

/** Map common MyGeotab API errors to user-friendly messages */
function parseErrorMessage(error) {
    const s = String(error);
    if (s.indexOf("checksum") >= 0) return "NFC driver key entered incorrectly";
    if (s.indexOf("Index was outside") >= 0) return "Custom NFC driver key entered incorrectly";
    if (s.indexOf("DuplicateUserException") >= 0) return "User name already exists";
    if (s.indexOf("DuplicateException") >= 0) return "Driver key already exists";
    if (s.indexOf("The password cannot contain the username") >= 0)
        return "Password cannot contain username, first name or last name";
    if (s.indexOf("Password policy requires") >= 0) return "Password must be at least 8 characters";
    if (s.indexOf("Common passwords") >= 0) return "Common passwords are not allowed";
    if (s.indexOf("CompanyGroups cannot be null or empty") >= 0) return "Invalid group name";
    if (s.indexOf("SecurityGroups") >= 0) return "Invalid security clearance";
    return s.length > 120 ? s.substring(0, 120) + "..." : s;
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
            // Treat as raw ID
            result.push({ id: part });
        }
    }
    return result.length > 0 ? result : null;
}

/**
 * Resolve pipe-separated security group IDs into [{id: ...}] array.
 * Security groups are always referenced by ID.
 */
function resolveSecurityGroups(value) {
    if (!value) return null;
    const parts = value.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return parts.map((id) => ({ id }));
}

// ══════════════════════════════════════════════════════════════
// Entity Builder
// ══════════════════════════════════════════════════════════════

/** Coerce a string value to the appropriate JS type */
function coerceValue(field, value) {
    if (value === "" || value === undefined || value === null) return undefined;

    if (BOOLEAN_FIELDS.has(field)) {
        const lower = value.toString().toLowerCase();
        return lower === "true" || lower === "1" || lower === "yes" || lower === "on";
    }
    if (NUMBER_FIELDS.has(field)) {
        const num = parseFloat(value);
        return isNaN(num) ? undefined : num;
    }
    // Group fields are handled separately via resolveGroups
    return value;
}

/**
 * Build a MyGeotab User entity from a CSV row + defaults + caches.
 * Returns { entity, hosRuleSet } — hosRuleSet is added as a separate entity post-creation.
 */
function buildUserEntity(row, csvHeaders, defaults, groupCache) {
    const entity = {
        name: row.name,
        firstName: row.firstName,
        lastName: row.lastName,
        // Always set these defaults (matching SDK behavior)
        userAuthenticationType: "BasicAuthentication",
        activeFrom: new Date().toISOString(),
        activeTo: "2050-01-01T00:00:00.000Z",
    };

    // Apply config defaults
    if (defaults.timeZoneId) entity.timeZoneId = defaults.timeZoneId;
    if (defaults.fuelEconomyUnit) entity.fuelEconomyUnit = defaults.fuelEconomyUnit;
    if (defaults.isMetric !== undefined) entity.isMetric = defaults.isMetric;
    if (defaults.isDriver !== undefined) entity.isDriver = defaults.isDriver;

    // Password handling
    if (defaults.password) {
        entity.password = defaults.password;
    } else if (defaults.changePassword) {
        // No password + force change → generate temporary password
        entity.password = generateTemporaryPassword();
    }

    // changePassword default
    if (defaults.changePassword) {
        entity.changePassword = true;
    }

    // Delay verification email
    if (defaults.delayVerificationEmail) {
        entity.sendWelcomeEmail = false;
    }

    // Feature preview & HOS convenience defaults
    if (defaults.featurePreview !== undefined) entity.featurePreview = defaults.featurePreview;
    if (defaults.isYardMoveEnabled !== undefined) entity.isYardMoveEnabled = defaults.isYardMoveEnabled;
    if (defaults.isPersonalConveyanceEnabled !== undefined) entity.isPersonalConveyanceEnabled = defaults.isPersonalConveyanceEnabled;

    // Default groups — resolve names via cache
    if (defaults.companyGroups) {
        entity.companyGroups = resolveGroups(defaults.companyGroups, groupCache);
    }
    if (defaults.securityGroups) {
        entity.securityGroups = resolveSecurityGroups(defaults.securityGroups);
    }

    // Track hosRuleSet separately (added as UserHosRuleSet after user creation)
    let hosRuleSet = null;

    // Override with CSV column values
    for (const header of csvHeaders) {
        if (MANDATORY_FIELDS.includes(header)) continue;
        const rawValue = row[header];
        if (rawValue === "" || rawValue === undefined) continue;

        // hosRuleSet → track separately, don't set on entity
        if (header === "hosRuleSet") {
            hosRuleSet = rawValue;
            continue;
        }

        // NFC keys → handled below
        if (header === "nfcKey" || header === "customNfcKey") continue;

        // Group fields → resolve via cache
        if (GROUP_FIELDS.has(header)) {
            if (header === "securityGroups") {
                const resolved = resolveSecurityGroups(rawValue);
                if (resolved) entity.securityGroups = resolved;
            } else {
                const resolved = resolveGroups(rawValue, groupCache);
                if (resolved) entity[header] = resolved;
            }
            continue;
        }

        // Standard field coercion
        const coerced = coerceValue(header, rawValue);
        if (coerced !== undefined) {
            entity[header] = coerced;
        }
    }

    // Password from CSV overrides default
    if (csvHeaders.includes("password") && row.password) {
        entity.password = row.password;
    } else if (!entity.password && entity.changePassword) {
        // changePassword set but still no password → generate one
        entity.password = generateTemporaryPassword();
    }

    // sendWelcomeEmail from CSV overrides default
    if (csvHeaders.includes("sendWelcomeEmail") && row.sendWelcomeEmail) {
        const val = row.sendWelcomeEmail.toString().toLowerCase();
        entity.sendWelcomeEmail = val === "true" || val === "1" || val === "yes";
    }

    // NFC keys → build keys array + auto-detect driver
    const nfcKey = row.nfcKey || "";
    const customNfcKey = row.customNfcKey || "";
    const keys = [];

    if (nfcKey) {
        keys.push({
            serialNumber: nfcKey,
            driverKeyType: "Nfc",
            isImmobilizeOnly: true,
        });
    }
    if (customNfcKey) {
        const num = parseFloat(customNfcKey);
        if (!isNaN(num) && num > 0 && num < 72057594037927940) {
            keys.push({
                serialNumber: customNfcKey,
                driverKeyType: "CustomNfc",
                isImmobilizeOnly: true,
            });
        }
    }

    if (keys.length > 0) {
        entity.keys = keys;
        entity.isDriver = true;
        entity.driverGroups = entity.companyGroups;
        entity.viewDriversOwnDataOnly = false;
    }

    // License number → auto-detect driver
    const licenseNumber = row.licenseNumber || "";
    if (licenseNumber) {
        entity.licenseNumber = licenseNumber;
        entity.isDriver = true;
        entity.driverGroups = entity.companyGroups;
        entity.viewDriversOwnDataOnly = false;
    }

    const licenseProvince = row.licenseProvince || "";
    if (licenseProvince) {
        entity.licenseProvince = licenseProvince;
    }

    return { entity, hosRuleSet };
}

// ══════════════════════════════════════════════════════════════
// Batched Upload with Rate Limiting
// ══════════════════════════════════════════════════════════════

function batchDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchedUpload(api, calls, hosRuleSetMap, addLog, onProgress) {
    const allResults = [];
    const totalBatches = Math.ceil(calls.length / BATCH_SIZE);

    for (let i = 0; i < calls.length; i += BATCH_SIZE) {
        const batch = calls.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        if (totalBatches > 1) {
            addLog(`Batch ${batchNum}/${totalBatches} (${batch.length} users)...`, "info");
        }

        try {
            const results = await apiMultiCall(api, batch);
            for (let j = 0; j < batch.length; j++) {
                allResults.push({ index: i + j, success: true, userId: results[j] });
            }
        } catch (err) {
            addLog(`Batch ${batchNum} failed, processing individually...`, "warn");
            for (let j = 0; j < batch.length; j++) {
                try {
                    const result = await apiCall(api, "Add", batch[j][1]);
                    allResults.push({ index: i + j, success: true, userId: result });
                } catch (singleErr) {
                    allResults.push({
                        index: i + j,
                        success: false,
                        error: parseErrorMessage(singleErr),
                    });
                }
            }
        }

        if (onProgress) onProgress(Math.min(i + batch.length, calls.length));

        // Delay before next batch
        if (i + BATCH_SIZE < calls.length) {
            await batchDelay(BATCH_DELAY_MS);
        }
    }

    // ── Post-creation: Add HOS Rulesets ──
    const hosCalls = [];
    for (const r of allResults) {
        if (r.success && hosRuleSetMap[r.index]) {
            hosCalls.push([
                "Add",
                {
                    typeName: "UserHosRuleSet",
                    entity: {
                        dateTime: new Date().toISOString(),
                        hosRuleSet: { id: hosRuleSetMap[r.index] },
                        user: { id: r.userId },
                    },
                },
            ]);
        }
    }

    if (hosCalls.length > 0) {
        addLog(`Assigning HOS rulesets to ${hosCalls.length} users...`, "info");
        try {
            await apiMultiCall(api, hosCalls);
            addLog(`HOS rulesets assigned successfully`, "success");
        } catch (hosErr) {
            addLog(`Warning: Failed to assign some HOS rulesets: ${parseErrorMessage(hosErr)}`, "warn");
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

function TemplateBuilder({ selectedFields, onToggleField, onSelectAll, onClearAll, onDownload, onDownloadExcel }) {
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
                    Download CSV
                </button>
                <button className="buu-btn-template buu-btn-template--excel" onClick={onDownloadExcel}>
                    Download Excel
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

function DefaultsPanel({ defaults, onChange, timeZones }) {
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
                        Groups use pipe <code>|</code> separator (e.g. <code>Drivers|West</code>).
                    </p>
                    <div className="buu-defaults-grid">
                        <div className="buu-input-group">
                            <label className="buu-input-label">timeZoneId</label>
                            {timeZones.length > 0 ? (
                                <select
                                    className="buu-select"
                                    value={defaults.timeZoneId}
                                    onChange={(e) => onChange("timeZoneId", e.target.value)}
                                >
                                    {timeZones.map((tz) => (
                                        <option key={tz.id} value={tz.id}>
                                            {tz.id}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    className="buu-input"
                                    value={defaults.timeZoneId}
                                    onChange={(e) => onChange("timeZoneId", e.target.value)}
                                />
                            )}
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">fuelEconomyUnit</label>
                            <select
                                className="buu-select"
                                value={defaults.fuelEconomyUnit}
                                onChange={(e) => onChange("fuelEconomyUnit", e.target.value)}
                            >
                                <option value="MPGUS">MPG (US)</option>
                                <option value="MPGImperial">MPG (Imperial)</option>
                                <option value="LitersPer100Km">L/100 km</option>
                                <option value="KmPerLiter">km/L</option>
                            </select>
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">companyGroups (pipe-separated names or IDs)</label>
                            <input
                                className="buu-input"
                                value={defaults.companyGroups}
                                onChange={(e) => onChange("companyGroups", e.target.value)}
                                placeholder="GroupCompanyId"
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">securityGroups (pipe-separated IDs)</label>
                            <input
                                className="buu-input"
                                value={defaults.securityGroups}
                                onChange={(e) => onChange("securityGroups", e.target.value)}
                                placeholder="GroupDriveUserSecurityId"
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">password</label>
                            <input
                                className="buu-input"
                                type="password"
                                value={defaults.password}
                                onChange={(e) => onChange("password", e.target.value)}
                                placeholder="(empty = auto-generated if changePassword on)"
                            />
                        </div>
                        <div className="buu-input-group">
                            <label className="buu-input-label">featurePreview</label>
                            <select
                                className="buu-select"
                                value={defaults.featurePreview}
                                onChange={(e) => onChange("featurePreview", e.target.value)}
                            >
                                <option value="Disabled">Disabled</option>
                                <option value="Enabled">Enabled</option>
                            </select>
                        </div>
                    </div>
                    <div className="buu-checkbox-grid">
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
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-changePassword"
                                checked={defaults.changePassword}
                                onChange={(e) => onChange("changePassword", e.target.checked)}
                            />
                            <label htmlFor="def-changePassword">Force password change on next login</label>
                        </div>
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-delayEmail"
                                checked={defaults.delayVerificationEmail}
                                onChange={(e) => onChange("delayVerificationEmail", e.target.checked)}
                            />
                            <label htmlFor="def-delayEmail">Delay verification email</label>
                        </div>
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-isYardMoveEnabled"
                                checked={defaults.isYardMoveEnabled}
                                onChange={(e) => onChange("isYardMoveEnabled", e.target.checked)}
                            />
                            <label htmlFor="def-isYardMoveEnabled">isYardMoveEnabled</label>
                        </div>
                        <div className="buu-checkbox-row">
                            <input
                                type="checkbox"
                                id="def-isPersonalConveyanceEnabled"
                                checked={defaults.isPersonalConveyanceEnabled}
                                onChange={(e) => onChange("isPersonalConveyanceEnabled", e.target.checked)}
                            />
                            <label htmlFor="def-isPersonalConveyanceEnabled">isPersonalConveyanceEnabled</label>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function FieldReference() {
    const [open, setOpen] = useState(false);

    return (
        <div className="buu-ref-panel">
            <button className="buu-ref-toggle" onClick={() => setOpen(!open)}>
                <span>Field Reference Guide</span>
                <span className={`buu-defaults-arrow ${open ? "buu-defaults-arrow--open" : ""}`}>
                    ▼
                </span>
            </button>
            {open && (
                <div className="buu-ref-body">
                    <table className="buu-ref-table">
                        <thead>
                            <tr>
                                <th>Field</th>
                                <th>Mandatory</th>
                                <th>Type</th>
                                <th>Format</th>
                                <th>Default</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            {FIELD_REFERENCE.map((f) => (
                                <tr key={f.field} className={f.mandatory ? "buu-ref-mandatory" : ""}>
                                    <td><code>{f.field}</code></td>
                                    <td>{f.mandatory ? <span className="buu-tag buu-tag--mandatory">Yes</span> : "No"}</td>
                                    <td>{f.type}</td>
                                    <td>{f.format}</td>
                                    <td><code>{f.default}</code></td>
                                    <td>{f.description}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function UserTable({ users, csvHeaders }) {
    if (!users || users.length === 0) return null;

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

    // API data caches
    const [groupCache, setGroupCache] = useState(null); // { name → group object }
    const [timeZones, setTimeZones] = useState([]);
    const [apiDataLoaded, setApiDataLoaded] = useState(false);

    // CSV / file state
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState("");
    const [csvHeaders, setCsvHeaders] = useState([]);
    const [users, setUsers] = useState([]);

    // Processing state
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

    // ── Fetch API data on mount ──
    useEffect(() => {
        if (!geotabApi) return;

        let cancelled = false;

        async function fetchData() {
            try {
                // Fetch groups
                const groups = await apiCall(geotabApi, "Get", { typeName: "Group" });
                if (cancelled) return;
                const cache = {};
                for (const g of groups) {
                    const name = g.name || g.id;
                    cache[name] = g;
                }
                setGroupCache(cache);

                // Fetch time zones
                const tzs = await apiCall(geotabApi, "GetTimeZones", {});
                if (cancelled) return;
                tzs.sort((a, b) => a.id.localeCompare(b.id));
                setTimeZones(tzs);

                setApiDataLoaded(true);
                addLog(`Loaded ${groups.length} groups and ${tzs.length} time zones from database`, "info");
            } catch (err) {
                if (!cancelled) {
                    addLog("Failed to load groups/time zones: " + parseErrorMessage(err), "error");
                    // Still allow usage with raw IDs
                    setGroupCache({});
                    setApiDataLoaded(true);
                }
            }
        }

        fetchData();
        return () => { cancelled = true; };
    }, [geotabApi, addLog]);

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

    const handleDownloadTemplateExcel = useCallback(() => {
        const columns = [...MANDATORY_FIELDS, ...selectedFields];
        downloadXlsx([columns], "user_upload_template.xlsx", "Template");
        addLog(
            `Excel template downloaded with ${columns.length} columns: ${columns.join(", ")}`,
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

                const taggedRows = rows.map((row) => ({ ...row, _status: "pending", _error: "" }));

                setFileName(file.name);
                setCsvHeaders(headers);
                setUsers(taggedRows);
                setCompleted(false);

                // Log helpful info about group columns
                const groupCols = headers.filter((h) => GROUP_FIELDS.has(h));
                const driverCols = headers.filter((h) =>
                    ["nfcKey", "customNfcKey", "licenseNumber", "hosRuleSet"].includes(h)
                );
                let info = `Loaded ${rows.length} users from ${file.name} (${headers.length} columns)`;
                if (groupCols.length > 0) info += ` | Groups: ${groupCols.join(", ")} (use pipe | separator for multiple)`;
                if (driverCols.length > 0) info += ` | Driver fields: ${driverCols.join(", ")}`;
                addLog(info, "success");
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

        // Build multiCall array and track hosRuleSets
        const calls = [];
        const hosRuleSetMap = {}; // index → hosRuleSet value

        for (let i = 0; i < users.length; i++) {
            const { entity, hosRuleSet } = buildUserEntity(
                users[i],
                csvHeaders,
                defaults,
                groupCache
            );
            calls.push(["Add", { typeName: "User", entity }]);
            if (hosRuleSet) {
                hosRuleSetMap[i] = hosRuleSet;
            }
        }

        // Mark all as uploading
        setUsers((prev) => prev.map((u) => ({ ...u, _status: "uploading" })));

        const results = await batchedUpload(
            geotabApi,
            calls,
            hosRuleSetMap,
            addLog,
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
    }, [geotabApi, users, csvHeaders, defaults, groupCache, addLog]);

    // ── Download Results ──
    const handleDownloadResults = useCallback(() => {
        const csv = generateResultsCsv(users, csvHeaders);
        downloadCsv(csv, "user_upload_results.csv");
        addLog("Results CSV downloaded", "info");
    }, [users, csvHeaders, addLog]);

    const handleDownloadResultsExcel = useCallback(() => {
        const allCols = [...csvHeaders, "status", "error"];
        const dataRows = users.map((user) =>
            allCols.map((col) => {
                if (col === "status") return user._status || "";
                if (col === "error") return user._error || "";
                return user[col] || "";
            })
        );
        downloadXlsx([allCols, ...dataRows], "user_upload_results.xlsx", "Results");
        addLog("Results Excel downloaded", "info");
    }, [users, csvHeaders, addLog]);

    // ── Render ──
    const progressPct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;

    return (
        <div className="buu-container">
            <h2>Bulk User Upload</h2>

            {!apiDataLoaded && (
                <div className="buu-banner buu-banner--info">
                    Loading groups and time zones from database...
                </div>
            )}

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
                        onDownloadExcel={handleDownloadTemplateExcel}
                    />

                    {/* Field Reference */}
                    <FieldReference />

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
                                CSV must include: {MANDATORY_FIELDS.join(", ")} | Groups use pipe <code>|</code> separator
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
                    <DefaultsPanel
                        defaults={defaults}
                        onChange={handleDefaultChange}
                        timeZones={timeZones}
                    />

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
                            <>
                                <button
                                    className="buu-btn-full buu-btn-secondary"
                                    onClick={handleDownloadResults}
                                >
                                    Results CSV
                                </button>
                                <button
                                    className="buu-btn-full buu-btn-excel"
                                    onClick={handleDownloadResultsExcel}
                                >
                                    Results Excel
                                </button>
                            </>
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
