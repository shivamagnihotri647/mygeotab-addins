/**
 * BulkGroupDeletion — React MyGeotab Add-In
 *
 * Bulk-removes groups from a MyGeotab database by first disassociating
 * each group from all connected entities, then deleting the group.
 * Ported from the Python Colab notebook (Bulk_Group_Deletion_Batched_Working).
 */

import React, { useState, useCallback, useRef, useEffect } from "react";

// ── Constants ──
const BATCH_SIZE = 100;
const RATE_LIMIT_PAUSE_MS = 61_000;
const RESULTS_LIMIT = 50_000;

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
// Utility Functions
// ══════════════════════════════════════════════════════════════

/** Parse CSV text into array of group IDs (one per line, skip blanks/headers) */
function parseCsv(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.toLowerCase() !== "groupid" && line.toLowerCase() !== "group id" && line.toLowerCase() !== "id");
}

/**
 * Parse the MyGeotab Remove error to extract connected entity map.
 * The error's `data.info` field contains a JSON string with entity connections.
 */
function parseGroupConnections(err) {
    try {
        const errObj = typeof err === "string" ? JSON.parse(err) : err;
        let infoStr = null;

        // Navigate to the data.info field
        if (errObj?.data?.info) {
            infoStr = errObj.data.info;
        } else if (errObj?.errors?.[0]?.data?.info) {
            infoStr = errObj.errors[0].data.info;
        } else if (typeof errObj === "string") {
            // The error itself might be a string containing JSON
            const match = errObj.match(/\{[\s\S]*\}/);
            if (match) infoStr = match[0];
        }

        if (!infoStr) return null;

        const parsed = typeof infoStr === "string" ? JSON.parse(infoStr) : infoStr;

        // Filter out the "group" key (it's the group itself) and empty arrays
        const connections = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (key === "group") continue;
            if (Array.isArray(value) && value.length > 0) {
                connections[key] = value.map((item) =>
                    typeof item === "object" && item.id ? item.id : item
                );
            }
        }
        return Object.keys(connections).length > 0 ? connections : null;
    } catch {
        return null;
    }
}

/**
 * Recursively remove a group ID from a GroupFilter condition tree.
 * Returns the pruned tree, or null if the entire tree is removed.
 */
function removeGroupFromCondition(condition, groupId) {
    if (!condition) return null;

    // Leaf node
    if (condition.groupId) {
        return condition.groupId === groupId ? null : condition;
    }

    // Branch node with children
    if (condition.groupFilterConditions) {
        const newChildren = condition.groupFilterConditions
            .map((child) => removeGroupFromCondition(child, groupId))
            .filter((child) => child !== null);

        if (newChildren.length === 0) return null;
        if (newChildren.length === 1) return newChildren[0]; // collapse single child
        return { ...condition, groupFilterConditions: newChildren };
    }

    return condition;
}

/** Count leaf nodes in a condition tree */
function countConditionGroups(condition) {
    if (!condition) return 0;
    if (condition.groupId) return 1;
    if (condition.groupFilterConditions) {
        return condition.groupFilterConditions.reduce(
            (sum, child) => sum + countConditionGroups(child),
            0
        );
    }
    return 0;
}

/** Normalize condition to clean object format */
function normalizeCondition(condition) {
    if (!condition) return null;
    if (condition.groupId) return { groupId: condition.groupId };
    if (condition.groupFilterConditions) {
        return {
            relation: condition.relation || "Or",
            groupFilterConditions: condition.groupFilterConditions.map(normalizeCondition),
        };
    }
    return condition;
}

/**
 * Remove a group ID from an array of {id} objects.
 * If the array becomes empty, replace with [{id: "GroupCompanyId"}].
 * @param {boolean} allowEmpty - if true, return [] instead of fallback
 */
function removeGroupFromList(groups, groupId, allowEmpty = false) {
    const filtered = groups.filter((g) => g.id !== groupId);
    if (filtered.length === 0 && !allowEmpty) return [{ id: "GroupCompanyId" }];
    return filtered;
}

/** Deep search: check if an object contains a specific value anywhere */
function hasValue(obj, value) {
    if (obj === value) return true;
    if (typeof obj === "object" && obj !== null) {
        for (const v of Object.values(obj)) {
            if (hasValue(v, value)) return true;
        }
    }
    return false;
}

// ══════════════════════════════════════════════════════════════
// Batched MultiCall with Rate Limiting
// ══════════════════════════════════════════════════════════════

async function batchedMultiCall(api, calls, addLog, onCountdown) {
    const allResults = [];

    for (let i = 0; i < calls.length; i += BATCH_SIZE) {
        const batch = calls.slice(i, i + BATCH_SIZE);

        try {
            const results = await apiMultiCall(api, batch);
            allResults.push(...results);
        } catch (err) {
            addLog(`Multicall batch failed, retrying with smaller batches...`, "warn");
            const retryResults = await retryFailedMultiCall(api, batch, 3, addLog);
            allResults.push(...retryResults);
        }

        // Rate limit pause between batches
        if (i + BATCH_SIZE < calls.length) {
            addLog(`Rate limit: waiting 61s before next batch...`, "warn");
            await countdownPause(RATE_LIMIT_PAUSE_MS, onCountdown);
        }
    }

    return allResults;
}

async function retryFailedMultiCall(api, batch, maxRetries, addLog) {
    if (maxRetries <= 0 || batch.length === 0) return [];

    const halfSize = Math.max(1, Math.floor(batch.length / 2));
    const results = [];

    for (let i = 0; i < batch.length; i += halfSize) {
        const subBatch = batch.slice(i, i + halfSize);
        try {
            const subResults = await apiMultiCall(api, subBatch);
            results.push(...subResults);
        } catch (err) {
            addLog(`Sub-batch failed (retries left: ${maxRetries - 1}), halving again...`, "warn");
            const retryResults = await retryFailedMultiCall(api, subBatch, maxRetries - 1, addLog);
            results.push(...retryResults);
        }
    }

    return results;
}

function countdownPause(ms, onCountdown) {
    return new Promise((resolve) => {
        let remaining = Math.ceil(ms / 1000);
        onCountdown?.(remaining);
        const interval = setInterval(() => {
            remaining -= 1;
            onCountdown?.(remaining);
            if (remaining <= 0) {
                clearInterval(interval);
                onCountdown?.(0);
                resolve();
            }
        }, 1000);
    });
}

// ══════════════════════════════════════════════════════════════
// Entity Disassociation Functions
// ══════════════════════════════════════════════════════════════

/** Disassociate devices from a group */
async function disassociateDevices(api, ids, groupId, addLog, onCountdown) {
    addLog(`  Disassociating ${ids.length} device(s)...`);
    const getCalls = ids.map((id) => ["Get", { typeName: "Device", search: { id } }]);
    const deviceResults = await batchedMultiCall(api, getCalls, addLog, onCountdown);

    const setCalls = [];
    for (const result of deviceResults) {
        if (!Array.isArray(result) || result.length === 0) continue;
        const device = result[0];
        device.groups = removeGroupFromList(device.groups || [], groupId);
        setCalls.push(["Set", { typeName: "Device", entity: device }]);
    }

    if (setCalls.length > 0) {
        await batchedMultiCall(api, setCalls, addLog, onCountdown);
        addLog(`  Updated ${setCalls.length} device(s).`, "success");
    }
}

/** Disassociate zones from a group */
async function disassociateZones(api, ids, groupId, addLog, onCountdown) {
    addLog(`  Disassociating ${ids.length} zone(s)...`);
    const getCalls = ids.map((id) => ["Get", { typeName: "Zone", search: { id } }]);
    const zoneResults = await batchedMultiCall(api, getCalls, addLog, onCountdown);

    const setCalls = [];
    for (const result of zoneResults) {
        if (!Array.isArray(result) || result.length === 0) continue;
        const zone = result[0];
        zone.groups = removeGroupFromList(zone.groups || [], groupId);
        setCalls.push(["Set", { typeName: "Zone", entity: zone }]);
    }

    if (setCalls.length > 0) {
        await batchedMultiCall(api, setCalls, addLog, onCountdown);
        addLog(`  Updated ${setCalls.length} zone(s).`, "success");
    }
}

/** Disassociate addInData from a group */
async function disassociateAddInData(api, ids, groupId, addLog, onCountdown) {
    addLog(`  Disassociating ${ids.length} addInData item(s)...`);

    // Process in chunks of 100 IDs
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const chunk = ids.slice(i, i + BATCH_SIZE);
        const getCalls = chunk.map((id) => ["Get", { typeName: "AddInData", search: { id } }]);
        const results = await batchedMultiCall(api, getCalls, addLog, onCountdown);

        const setCalls = [];
        for (const result of results) {
            if (!Array.isArray(result) || result.length === 0) continue;
            const item = result[0];
            item.groups = removeGroupFromList(item.groups || [], groupId);
            setCalls.push(["Set", { typeName: "AddInData", entity: item }]);
        }

        if (setCalls.length > 0) {
            await batchedMultiCall(api, setCalls, addLog, onCountdown);
        }
    }
    addLog(`  Updated addInData items.`, "success");
}

/** Disassociate trailers — find devices referencing trailer, remove group from those */
async function disassociateTrailers(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} trailer(s)...`);
    const allDevices = await apiCall(api, "Get", { typeName: "Device", resultsLimit: RESULTS_LIMIT });

    for (const trailerId of ids) {
        for (const device of allDevices) {
            if (hasValue(device, trailerId)) {
                const groups = device.groups || [];
                if (groups.some((g) => g.id === groupId)) {
                    device.groups = removeGroupFromList(groups, groupId);
                    try {
                        await apiCall(api, "Set", { typeName: "Device", entity: device });
                    } catch (err) {
                        addLog(`  Warning: Failed to update device ${device.id} for trailer ${trailerId}: ${err}`, "warn");
                    }
                }
            }
        }
    }
    addLog(`  Processed trailer(s).`, "success");
}

/** Disassociate rules from a group */
async function disassociateRules(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} rule(s)...`);
    for (const ruleId of ids) {
        try {
            const results = await apiCall(api, "Get", { typeName: "Rule", search: { id: ruleId } });
            if (results.length === 0) continue;
            const rule = results[0];
            rule.groups = removeGroupFromList(rule.groups || [], groupId);
            await apiCall(api, "Set", { typeName: "Rule", entity: rule });
        } catch (err) {
            addLog(`  Warning: Failed to update rule ${ruleId}: ${err}`, "warn");
        }
    }
    addLog(`  Processed rule(s).`, "success");
}

/** Disassociate eventRules from a group */
async function disassociateEventRules(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} eventRule(s)...`);
    for (const eventRuleId of ids) {
        try {
            const results = await apiCall(api, "Get", { typeName: "EventRule", search: { id: eventRuleId } });
            if (results.length === 0) continue;
            const rule = results[0];
            rule.groups = removeGroupFromList(rule.groups || [], groupId);
            await apiCall(api, "Set", { typeName: "EventRule", entity: rule });
        } catch (err) {
            addLog(`  Warning: Failed to update eventRule ${eventRuleId}: ${err}`, "warn");
        }
    }
    addLog(`  Processed eventRule(s).`, "success");
}

/** Disassociate defects — defects are actually sub-Groups, strip from parent's groups */
async function disassociateDefects(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} defect(s)...`);
    for (const defectId of ids) {
        try {
            const results = await apiCall(api, "Get", { typeName: "Group", search: { id: defectId } });
            if (results.length === 0) continue;
            const group = results[0];
            group.groups = removeGroupFromList(group.groups || [], groupId);
            await apiCall(api, "Set", { typeName: "Group", entity: group });
        } catch (err) {
            addLog(`  Warning: Failed to update defect group ${defectId}: ${err}`, "warn");
        }
    }
    addLog(`  Processed defect(s).`, "success");
}

/** Disassociate deviceAutoGroups — remove from device's autoGroups[] */
async function disassociateDeviceAutoGroups(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} deviceAutoGroup(s)...`);
    for (const deviceId of ids) {
        try {
            const results = await apiCall(api, "Get", { typeName: "Device", search: { id: deviceId } });
            if (results.length === 0) continue;
            const device = results[0];
            device.autoGroups = (device.autoGroups || []).filter((g) => g.id !== groupId);
            await apiCall(api, "Set", { typeName: "Device", entity: device });
        } catch (err) {
            addLog(`  Warning: Failed to update deviceAutoGroup for ${deviceId}: ${err}`, "warn");
        }
    }
    addLog(`  Processed deviceAutoGroup(s).`, "success");
}

/** Disassociate customReportSchedules from a group */
async function disassociateCustomReportSchedules(api, ids, groupId, addLog) {
    addLog(`  Disassociating ${ids.length} customReportSchedule(s)...`);
    const uniqueIds = [...new Set(ids)];

    for (const scheduleId of uniqueIds) {
        try {
            const results = await apiCall(api, "Get", { typeName: "CustomReportSchedule", search: { id: scheduleId } });
            if (results.length === 0) continue;
            const schedule = results[0];

            // Remove from groups
            if (schedule.groups) {
                schedule.groups = removeGroupFromList(schedule.groups, groupId);
            }

            // Remove from scopeGroups
            if (schedule.scopeGroups) {
                schedule.scopeGroups = removeGroupFromList(schedule.scopeGroups, groupId);
            }

            // Remove from includeAllChildrenGroups (can be empty)
            if (schedule.includeAllChildrenGroups) {
                schedule.includeAllChildrenGroups = (schedule.includeAllChildrenGroups || []).filter(
                    (g) => g.id !== groupId
                );
            }

            // Rebuild scopeGroupFilter if needed
            if (schedule.scopeGroupFilter?.groupFilterCondition) {
                const beforeCount = countConditionGroups(schedule.scopeGroupFilter.groupFilterCondition);
                const newCondition = removeGroupFromCondition(
                    schedule.scopeGroupFilter.groupFilterCondition,
                    groupId
                );
                const afterCount = countConditionGroups(newCondition);

                if (afterCount === 0) {
                    // All groups removed — reset to company group
                    schedule.scopeGroupFilter.groupFilterCondition = {
                        groupId: "GroupCompanyId",
                    };
                } else if (afterCount === 1 && beforeCount > 1) {
                    // Collapsed to single leaf
                    schedule.scopeGroupFilter.groupFilterCondition = normalizeCondition(newCondition);
                } else {
                    schedule.scopeGroupFilter.groupFilterCondition = normalizeCondition(newCondition);
                }
            } else if (!schedule.scopeGroupFilter && schedule.scopeGroups) {
                // No filter exists — rebuild from remaining scopeGroups
                if (schedule.scopeGroups.length === 1) {
                    schedule.scopeGroupFilter = {
                        groupFilterCondition: { groupId: schedule.scopeGroups[0].id },
                    };
                } else if (schedule.scopeGroups.length > 1) {
                    schedule.scopeGroupFilter = {
                        groupFilterCondition: {
                            relation: "Or",
                            groupFilterConditions: schedule.scopeGroups.map((g) => ({
                                groupId: g.id,
                            })),
                        },
                    };
                }
            }

            await apiCall(api, "Set", { typeName: "CustomReportSchedule", entity: schedule });
        } catch (err) {
            addLog(`  Warning: Failed to update customReportSchedule ${scheduleId}: ${err}`, "warn");
        }
    }
    addLog(`  Processed customReportSchedule(s).`, "success");
}

/**
 * Disassociate users/drivers from a group.
 * Handles companyGroups, driverGroups, reportGroups, and accessGroupFilter.
 */
async function disassociateUsers(api, userIds, driverIds, groupFilterIds, groupId, addLog) {
    // Combine all user-like entity IDs
    const allUserIds = [...new Set([...(userIds || []), ...(driverIds || [])])];
    if (allUserIds.length === 0 && (!groupFilterIds || groupFilterIds.length === 0)) return;

    addLog(`  Disassociating ${allUserIds.length} user(s)/driver(s)...`);

    // First, resolve which users have GroupFilters referencing this group
    const groupFilterUserMap = {}; // userId -> groupFilterId

    if (groupFilterIds && groupFilterIds.length > 0) {
        // Fetch all users to find which ones reference these groupFilter IDs
        const allUsers = await apiCall(api, "Get", { typeName: "User", resultsLimit: RESULTS_LIMIT });
        for (const user of allUsers) {
            for (const gfId of groupFilterIds) {
                if (hasValue(user, gfId)) {
                    const userDetail = await apiCall(api, "Get", { typeName: "User", search: { id: user.id } });
                    if (userDetail.length > 0 && userDetail[0].accessGroupFilter?.id) {
                        groupFilterUserMap[user.id] = userDetail[0].accessGroupFilter.id;
                    }
                    break;
                }
            }
        }
    }

    // Also handle report schedules with groupFilters
    if (groupFilterIds && groupFilterIds.length > 0) {
        await disassociateReportGroupFilters(api, groupFilterIds, groupId, addLog);
    }

    // Handle orphan groupFilters (no user or report references them)
    if (groupFilterIds && groupFilterIds.length > 0) {
        const referencedGfIds = new Set(Object.values(groupFilterUserMap));
        for (const gfId of groupFilterIds) {
            if (!referencedGfIds.has(gfId)) {
                // Try to remove the orphan GroupFilter directly
                try {
                    await apiCall(api, "Remove", { typeName: "GroupFilter", entity: { id: gfId } });
                    addLog(`  Removed orphan GroupFilter ${gfId}.`, "success");
                } catch {
                    // Might still be referenced — that's okay
                }
            }
        }
    }

    // Process each user
    for (const userId of allUserIds) {
        try {
            const results = await apiCall(api, "Get", { typeName: "User", search: { id: userId } });
            if (results.length === 0) continue;
            const user = results[0];
            const isDriver = driverIds?.includes(userId);
            const hasGroupFilter = groupFilterUserMap[userId] !== undefined;

            // Strip from reportGroups
            if (user.reportGroups) {
                user.reportGroups = removeGroupFromList(user.reportGroups, groupId);
            }

            if (hasGroupFilter) {
                // User has a GroupFilter — need to update the condition tree
                await disassociateUserWithGroupFilter(api, user, groupId, groupFilterUserMap[userId], isDriver, addLog);
            } else {
                // No GroupFilter — just strip from companyGroups and driverGroups
                await disassociateUserWithoutGroupFilter(api, user, groupId, isDriver, addLog);
            }
        } catch (err) {
            addLog(`  Warning: Failed to update user ${userId}: ${err}`, "warn");
        }
    }

    // Handle users that appear only in groupFilter conditions (not in userIds/driverIds)
    const usersOnlyInConditions = Object.keys(groupFilterUserMap).filter(
        (uid) => !allUserIds.includes(uid)
    );
    for (const userId of usersOnlyInConditions) {
        try {
            const results = await apiCall(api, "Get", { typeName: "User", search: { id: userId } });
            if (results.length === 0) continue;
            const user = results[0];
            await updateUserGroupFilter(api, user, groupId, groupFilterUserMap[userId], addLog);
        } catch (err) {
            addLog(`  Warning: Failed to update GroupFilter for user ${userId}: ${err}`, "warn");
        }
    }

    addLog(`  Processed user(s)/driver(s).`, "success");
}

/** Handle report schedules whose scopeGroupFilter references the group */
async function disassociateReportGroupFilters(api, groupFilterIds, groupId, addLog) {
    try {
        const reports = await apiCall(api, "Get", { typeName: "CustomReportSchedule", resultsLimit: RESULTS_LIMIT });
        for (const report of reports) {
            for (const gfId of groupFilterIds) {
                if (hasValue(report, gfId)) {
                    if (report.scopeGroupFilter?.groupFilterCondition) {
                        const newCondition = removeGroupFromCondition(
                            report.scopeGroupFilter.groupFilterCondition,
                            groupId
                        );
                        if (newCondition === null) {
                            report.scopeGroupFilter.groupFilterCondition = { groupId: "GroupCompanyId" };
                        } else {
                            report.scopeGroupFilter.groupFilterCondition = normalizeCondition(newCondition);
                        }
                        try {
                            await apiCall(api, "Set", { typeName: "CustomReportSchedule", entity: report });
                            addLog(`  Updated report schedule GroupFilter for ${report.id}.`, "success");
                        } catch (err) {
                            addLog(`  Warning: Failed to update report schedule ${report.id}: ${err}`, "warn");
                        }
                    }
                    break;
                }
            }
        }
    } catch (err) {
        addLog(`  Warning: Failed to process report GroupFilters: ${err}`, "warn");
    }
}

/** Disassociate a user that HAS a GroupFilter */
async function disassociateUserWithGroupFilter(api, user, groupId, groupFilterId, isDriver, addLog) {
    // Strip from companyGroups and driverGroups
    const origCompany = user.companyGroups || [];
    const origDriver = user.driverGroups || [];

    user.companyGroups = removeGroupFromList(origCompany, groupId);
    if (isDriver) {
        user.driverGroups = removeGroupFromList(origDriver, groupId);
    }

    // Update accessGroupFilter condition tree
    await updateUserGroupFilter(api, user, groupId, groupFilterId, addLog);
}

/** Disassociate a user that does NOT have a GroupFilter */
async function disassociateUserWithoutGroupFilter(api, user, groupId, isDriver, addLog) {
    const origCompany = user.companyGroups || [];

    // If already at root group, just fix driverGroups
    if (origCompany.length === 1 && origCompany[0].id === "GroupCompanyId") {
        if (isDriver && user.driverGroups) {
            user.driverGroups = removeGroupFromList(user.driverGroups, groupId);
        }
    } else {
        user.companyGroups = removeGroupFromList(origCompany, groupId);
        if (isDriver && user.driverGroups) {
            const newDriverGroups = removeGroupFromList(user.driverGroups, groupId, true);
            // If driverGroups becomes empty, fall back to companyGroups
            user.driverGroups = newDriverGroups.length > 0 ? newDriverGroups : [...user.companyGroups];
        }
    }

    try {
        await apiCall(api, "Set", { typeName: "User", entity: user });
    } catch (err) {
        addLog(`  Warning: Failed to set user ${user.id}: ${err}`, "warn");
    }
}

/** Update a user's accessGroupFilter condition tree to remove a group */
async function updateUserGroupFilter(api, user, groupId, groupFilterId, addLog) {
    try {
        // Fetch the GroupFilter
        const gfResults = await apiCall(api, "Get", { typeName: "GroupFilter", search: { id: groupFilterId } });
        if (gfResults.length === 0) {
            // GroupFilter not found — just Set the user
            await apiCall(api, "Set", { typeName: "User", entity: user });
            return;
        }

        const gf = gfResults[0];
        const condition = gf.groupFilterCondition;
        const beforeCount = countConditionGroups(condition);
        const newCondition = removeGroupFromCondition(condition, groupId);
        const afterCount = countConditionGroups(newCondition);

        if (beforeCount > 0 && afterCount === 0) {
            // All groups removed — nullify the GroupFilter, reset groups to company
            user.companyGroups = [{ id: "GroupCompanyId" }];
            user.driverGroups = [{ id: "GroupCompanyId" }];
            user.accessGroupFilter = null;
        } else if (afterCount === 1 && beforeCount > 1) {
            // Collapsed to single leaf — set condition directly
            user.accessGroupFilter = {
                ...gf,
                groupFilterCondition: normalizeCondition(newCondition),
            };
        } else if (newCondition) {
            user.accessGroupFilter = {
                ...gf,
                groupFilterCondition: normalizeCondition(newCondition),
            };
        }

        await apiCall(api, "Set", { typeName: "User", entity: user });
    } catch (err) {
        addLog(`  Warning: Failed to update GroupFilter for user ${user.id}: ${err}`, "warn");
    }
}

// ══════════════════════════════════════════════════════════════
// Process Group Orchestrator
// ══════════════════════════════════════════════════════════════

/**
 * Main orchestrator: probe a group for connections, then optionally disassociate and delete.
 * @param {boolean} dryRun - if true, only probe (don't disassociate/delete)
 * @returns {{ status, connections }} result
 */
async function processGroup(api, groupId, addLog, onCountdown, dryRun = false) {
    if (groupId === "GroupCompanyId") {
        addLog(`Skipping GroupCompanyId (root group cannot be deleted).`, "warn");
        return { status: "skipped", connections: null };
    }

    // Step 1: Try to remove the group directly
    addLog(`Attempting Remove for group ${groupId}...`);
    try {
        await apiCall(api, "Remove", { typeName: "Group", entity: { id: groupId } });
        // If no error, group was successfully deleted (no connections)
        addLog(`Group ${groupId} had no connections and was deleted.`, "success");
        return { status: "deleted", connections: null };
    } catch (err) {
        // Parse the error to find connected entities
        const connections = parseGroupConnections(err);
        if (!connections) {
            // Could not parse connections — maybe the group doesn't exist
            const errStr = typeof err === "object" ? JSON.stringify(err) : String(err);
            if (errStr.includes("does not exist") || errStr.includes("not found")) {
                addLog(`Group ${groupId} does not exist.`, "warn");
                return { status: "skipped", connections: null };
            }
            addLog(`Failed to parse connections for group ${groupId}: ${errStr}`, "error");
            return { status: "failed", connections: null };
        }

        // Log discovered connections
        const summary = Object.entries(connections)
            .map(([type, ids]) => `${type}: ${ids.length}`)
            .join(", ");
        addLog(`Group ${groupId} connections: ${summary}`);

        if (dryRun) {
            return { status: "probed", connections };
        }

        // Step 2: Disassociate all connected entities
        addLog(`Disassociating all connections for group ${groupId}...`);

        // Collect user/driver/groupFilter IDs for combined processing later
        let userIds = null;
        let driverIds = null;
        let groupFilterIds = null;

        for (const [entityType, ids] of Object.entries(connections)) {
            const normalizedType = entityType.replace(/s$/, ""); // "devices" -> "device"

            switch (normalizedType) {
                case "device":
                    await disassociateDevices(api, ids, groupId, addLog, onCountdown);
                    break;
                case "zone":
                    await disassociateZones(api, ids, groupId, addLog, onCountdown);
                    break;
                case "addInData":
                    await disassociateAddInData(api, ids, groupId, addLog, onCountdown);
                    break;
                case "trailer":
                    await disassociateTrailers(api, ids, groupId, addLog);
                    break;
                case "rule":
                    await disassociateRules(api, ids, groupId, addLog);
                    break;
                case "eventRule":
                    await disassociateEventRules(api, ids, groupId, addLog);
                    break;
                case "defect":
                    await disassociateDefects(api, ids, groupId, addLog);
                    break;
                case "customReportSchedule":
                    await disassociateCustomReportSchedules(api, ids, groupId, addLog);
                    break;
                case "deviceAutoGroup":
                    await disassociateDeviceAutoGroups(api, ids, groupId, addLog);
                    break;
                case "user":
                    userIds = ids;
                    break;
                case "driver":
                    driverIds = ids;
                    break;
                case "groupFilter":
                    groupFilterIds = ids;
                    break;
                default:
                    addLog(`  Unknown entity type "${entityType}" with ${ids.length} connection(s).`, "warn");
            }
        }

        // Process users/drivers/groupFilters together (they're interdependent)
        if (userIds || driverIds || groupFilterIds) {
            await disassociateUsers(api, userIds, driverIds, groupFilterIds, groupId, addLog);
        }

        // Step 3: Retry Remove
        addLog(`Retrying Remove for group ${groupId}...`);
        try {
            await apiCall(api, "Remove", { typeName: "Group", entity: { id: groupId } });
            addLog(`Group ${groupId} successfully deleted!`, "success");
            return { status: "deleted", connections };
        } catch (retryErr) {
            const errStr = typeof retryErr === "object" ? JSON.stringify(retryErr) : String(retryErr);
            addLog(`Failed to delete group ${groupId} after disassociation: ${errStr}`, "error");
            return { status: "failed", connections };
        }
    }
}

// ══════════════════════════════════════════════════════════════
// Sub-Components
// ══════════════════════════════════════════════════════════════

const LogEntry = ({ entry }) => (
    <div className={`bgd-log-entry bgd-log-entry--${entry.type}`}>
        <span className="bgd-log-dot" />
        <span className="bgd-log-time">{entry.time}</span>
        <span className="bgd-log-message">{entry.message}</span>
    </div>
);

const StatusBadge = ({ status }) => (
    <span className={`bgd-badge bgd-badge--${status}`}>{status}</span>
);

const GroupTable = ({ groups }) => (
    <div className="bgd-table-wrap">
        <table className="bgd-table">
            <thead>
                <tr>
                    <th>Group ID</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Connections</th>
                </tr>
            </thead>
            <tbody>
                {groups.map((g) => (
                    <tr key={g.id}>
                        <td className="bgd-table-id">{g.id}</td>
                        <td>{g.name || "—"}</td>
                        <td>
                            <StatusBadge status={g.status} />
                        </td>
                        <td className="bgd-connections">
                            {g.connections
                                ? Object.entries(g.connections)
                                      .map(([type, ids]) => `${type}: ${ids.length}`)
                                      .join(", ")
                                : "—"}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

const BulkGroupDeletion = ({ geotabApi }) => {
    // ── State ──
    const [groups, setGroups] = useState([]);
    const [processing, setProcessing] = useState(false);
    const [statusMessage, setStatusMessage] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [logs, setLogs] = useState([]);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [dragActive, setDragActive] = useState(false);

    // ── Refs ──
    const logEndRef = useRef(null);
    const fileInputRef = useRef(null);

    // ── Log helper ──
    const addLog = useCallback((message, type = "info") => {
        setLogs((prev) => [...prev, { time: timestamp(), message, type }]);
    }, []);

    // Auto-scroll log area
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);

    // ── Countdown handler for status message ──
    const handleCountdown = useCallback(
        (remaining) => {
            if (remaining > 0) {
                setStatusMessage(`Rate limit pause: ${remaining}s remaining...`);
            }
        },
        []
    );

    // ── File handling ──
    const handleFileLoad = useCallback(
        async (file) => {
            if (!file) return;
            setErrorMessage("");

            const text = await file.text();
            const ids = parseCsv(text);

            if (ids.length === 0) {
                setErrorMessage("No valid group IDs found in the file.");
                return;
            }

            addLog(`Loaded ${ids.length} group ID(s) from ${file.name}.`);

            // Try to resolve group names
            const groupEntries = ids.map((id) => ({
                id,
                name: "",
                status: "pending",
                connections: null,
            }));

            // Fetch group names in bulk
            if (geotabApi) {
                try {
                    const getCalls = ids.map((id) => ["Get", { typeName: "Group", search: { id } }]);
                    const results = await batchedMultiCall(geotabApi, getCalls, addLog, handleCountdown);
                    for (let i = 0; i < results.length; i++) {
                        if (Array.isArray(results[i]) && results[i].length > 0) {
                            groupEntries[i].name = results[i][0].name || "";
                        }
                    }
                    addLog(`Resolved names for ${results.length} group(s).`, "success");
                } catch (err) {
                    addLog(`Could not resolve group names: ${err}`, "warn");
                }
            }

            setGroups(groupEntries);
            setStatusMessage(`${ids.length} group(s) loaded and ready.`);
        },
        [geotabApi, addLog, handleCountdown]
    );

    const handleFileDrop = useCallback(
        (e) => {
            e.preventDefault();
            setDragActive(false);
            if (processing) return;
            const file = e.dataTransfer?.files?.[0];
            if (file) handleFileLoad(file);
        },
        [processing, handleFileLoad]
    );

    const handleFileChange = useCallback(
        (e) => {
            const file = e.target.files?.[0];
            if (file) handleFileLoad(file);
            e.target.value = "";
        },
        [handleFileLoad]
    );

    const clearFile = useCallback(() => {
        setGroups([]);
        setStatusMessage("");
        setErrorMessage("");
        setProgress({ done: 0, total: 0 });
    }, []);

    // ── Find Connections (dry run) ──
    const handleFindConnections = useCallback(async () => {
        if (groups.length === 0 || !geotabApi) return;
        setProcessing(true);
        setErrorMessage("");
        setProgress({ done: 0, total: groups.length });
        addLog(`Probing connections for ${groups.length} group(s)...`);

        const updated = [...groups];
        for (let i = 0; i < updated.length; i++) {
            const g = updated[i];
            updated[i] = { ...g, status: "probing" };
            setGroups([...updated]);

            const result = await processGroup(geotabApi, g.id, addLog, handleCountdown, true);
            updated[i] = {
                ...g,
                status: result.status === "deleted" ? "deleted" : result.status,
                connections: result.connections,
            };
            setGroups([...updated]);
            setProgress({ done: i + 1, total: updated.length });
        }

        const probed = updated.filter((g) => g.connections).length;
        const deleted = updated.filter((g) => g.status === "deleted").length;
        addLog(
            `Probe complete: ${probed} group(s) with connections, ${deleted} already deleted/no connections.`,
            "success"
        );
        setStatusMessage(`Probe complete. ${probed} group(s) have connections to disassociate.`);
        setProcessing(false);
    }, [groups, geotabApi, addLog, handleCountdown]);

    // ── Remove Groups (full pipeline) ──
    const handleRemoveGroups = useCallback(async () => {
        if (groups.length === 0 || !geotabApi) return;
        setProcessing(true);
        setErrorMessage("");
        setProgress({ done: 0, total: groups.length });
        addLog(`Starting bulk group deletion for ${groups.length} group(s)...`);

        const updated = [...groups];
        for (let i = 0; i < updated.length; i++) {
            const g = updated[i];
            if (g.status === "deleted") {
                addLog(`Skipping group ${g.id} (already deleted).`);
                setProgress({ done: i + 1, total: updated.length });
                continue;
            }

            updated[i] = { ...g, status: "deleting" };
            setGroups([...updated]);

            const result = await processGroup(geotabApi, g.id, addLog, handleCountdown, false);
            updated[i] = {
                ...g,
                status: result.status,
                connections: result.connections || g.connections,
            };
            setGroups([...updated]);
            setProgress({ done: i + 1, total: updated.length });
        }

        const deleted = updated.filter((g) => g.status === "deleted").length;
        const failed = updated.filter((g) => g.status === "failed").length;
        addLog(
            `Bulk deletion complete: ${deleted} deleted, ${failed} failed, ${updated.length - deleted - failed} skipped.`,
            deleted > 0 ? "success" : "warn"
        );
        setStatusMessage(`Done! ${deleted}/${updated.length} group(s) deleted.`);
        setProcessing(false);
    }, [groups, geotabApi, addLog, handleCountdown]);

    // ── Derived state ──
    const hasGroups = groups.length > 0;
    const canProbe = hasGroups && !processing;
    const canRemove = hasGroups && !processing;
    const progressPct =
        progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    // ══════════════════════════════════════════════════════════
    // Render
    // ══════════════════════════════════════════════════════════

    return (
        <div className="bgd-container">
            <div className="geotabPageHeader">
                <h1 className="geotabPageName">Bulk Group Deletion</h1>
            </div>

            <div className="bgd-layout">
                {/* ── Left Column: Controls ── */}
                <div className="bgd-controls-panel">
                    {/* Upload area */}
                    <div className="bgd-form-group">
                        <label className="bgd-label">Upload CSV (one Group ID per line)</label>
                        <div
                            className={`bgd-upload-area${dragActive ? " bgd-upload-area--active" : ""}${processing ? " bgd-upload-area--disabled" : ""}`}
                            onDragOver={(e) => {
                                e.preventDefault();
                                if (!processing) setDragActive(true);
                            }}
                            onDragLeave={() => setDragActive(false)}
                            onDrop={handleFileDrop}
                            onClick={() => !processing && fileInputRef.current?.click()}
                        >
                            <div className="bgd-upload-icon">&#128196;</div>
                            <p className="bgd-upload-text">
                                Drag & drop a CSV file here, or click to browse
                            </p>
                            <p className="bgd-upload-subtext">.csv files only</p>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".csv"
                                style={{ display: "none" }}
                                onChange={handleFileChange}
                                disabled={processing}
                            />
                        </div>

                        {hasGroups && (
                            <div className="bgd-file-info">
                                <span>{groups.length} group(s) loaded</span>
                                {!processing && (
                                    <button className="bgd-file-clear" onClick={clearFile}>
                                        &times;
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Group table */}
                    {hasGroups && <GroupTable groups={groups} />}

                    {/* Buttons */}
                    <div className="bgd-btn-row">
                        <button
                            className="geotabButton bgd-btn-secondary bgd-btn-full"
                            onClick={handleFindConnections}
                            disabled={!canProbe}
                        >
                            {processing ? "Processing..." : "Find Connections"}
                        </button>
                        <button
                            className="geotabButton bgd-btn-danger bgd-btn-full"
                            onClick={handleRemoveGroups}
                            disabled={!canRemove}
                        >
                            {processing ? "Removing..." : "Remove Groups"}
                        </button>
                    </div>

                    {/* Progress bar */}
                    {processing && progress.total > 0 && (
                        <div className="bgd-form-group">
                            <div className="bgd-progress-bar">
                                <div
                                    className="bgd-progress-fill"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <div className="bgd-progress-label">
                                {progress.done} / {progress.total} ({progressPct}%)
                            </div>
                        </div>
                    )}

                    {/* Status banner */}
                    {statusMessage && (
                        <div className="bgd-banner bgd-banner--info">{statusMessage}</div>
                    )}

                    {/* Error banner */}
                    {errorMessage && (
                        <div className="bgd-banner bgd-banner--error">
                            <span>{errorMessage}</span>
                            <button
                                className="bgd-banner-close"
                                onClick={() => setErrorMessage("")}
                            >
                                &times;
                            </button>
                        </div>
                    )}
                </div>

                {/* ── Right Column: Log ── */}
                <div className="bgd-log-panel">
                    <div className="bgd-log-header">
                        <label className="bgd-label">
                            Progress Log
                            {logs.length > 0 && (
                                <span className="bgd-log-count"> ({logs.length})</span>
                            )}
                        </label>
                        {logs.length > 0 && (
                            <button className="bgd-log-clear" onClick={() => setLogs([])}>
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="bgd-log-area">
                        {logs.length === 0 ? (
                            <div className="bgd-log-empty">
                                Upload a CSV file and click "Find Connections" to begin.
                            </div>
                        ) : (
                            logs.map((entry, i) => <LogEntry key={i} entry={entry} />)
                        )}
                        <div ref={logEndRef} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BulkGroupDeletion;
