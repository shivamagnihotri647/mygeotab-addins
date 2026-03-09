#!/usr/bin/env python3
"""Copy the entire group tree from one MyGeotab database to another."""

import getpass
import json
import os
import sys
import time
from datetime import datetime

import mygeotab

BATCH_SIZE = 350
BATCH_PAUSE = 61  # seconds


# Well-known system group ID prefixes — these exist in every database and should not be copied
SYSTEM_GROUP_IDS = {
    "GroupCompanyId",
    "GroupNothingId",
    "GroupSecurityId",
    "GroupSupervisorsId",
    "GroupEverythingSecurityId",
    "GroupNothingSecurityId",
    "GroupDriverActivityId",
    "GroupAssetInformationId",
    "GroupUserSecurityId",
    "GroupDriveUserSecurityId",
    "GroupPersonalGroupId",
    "GroupPrivateUserId",
    "GroupRootId",
    "GroupDefectsId",
    "GroupTrailerId",
    "GroupVehicleId",
    "GroupDriverId",
    "GroupZoneId",
    "GroupWorkTimeId",
    "GroupWorkHolidayId",
    "GroupElectricEnergyEconomyGroupId",
    "GroupElectricEnergyUsedGroupId",
    "GroupFuelEconomyGroupId",
    "GroupSharedDeviceGroupId",
    "GroupNewsNotificationsId",
    "GroupEVBatteryHealthGroupId",
}


LOG_FILE = None


def log(msg=""):
    """Print to console and append to log file."""
    print(msg)
    if LOG_FILE:
        LOG_FILE.write(msg + "\n")
        LOG_FILE.flush()



def authenticate(server, database, username, password):
    """Authenticate and return an API object."""
    api = mygeotab.API(username=username, password=password, database=database, server=server)
    api.authenticate()
    return api


def is_system_group_id(gid):
    """Check if a group ID is a built-in system group."""
    return isinstance(gid, str) and gid.startswith("Group")


def fetch_group_tree(api):
    """Fetch all groups and build parent map by walking children top-down from GroupCompanyId.

    The API doesn't return 'parent' on groups, but it does return 'children'.
    We walk the tree from GroupCompanyId downward to build:
      - by_id: group ID -> group data
      - parent_map: child group ID -> parent group ID
      - ordered: list of (group, parent_id) in BFS order (parents before children)
    """
    all_groups = api.call("Get", type_name="Group")
    log(f"  Total groups in database: {len(all_groups)}")

    by_id = {g["id"]: g for g in all_groups}

    # BFS from GroupCompanyId using children references
    parent_map = {}  # child_id -> parent_id
    ordered = []     # (group, parent_id) in creation order

    company = by_id.get("GroupCompanyId")
    if not company:
        log("  ERROR: GroupCompanyId not found in database!")
        return [], by_id, parent_map

    queue = [("GroupCompanyId", company)]
    while queue:
        parent_id, parent_group = queue.pop(0)
        children = parent_group.get("children", [])
        for child_ref in children:
            child_id = child_ref.get("id", "")
            if not child_id or is_system_group_id(child_id):
                continue
            child_group = by_id.get(child_id)
            if not child_group:
                continue
            parent_map[child_id] = parent_id
            ordered.append((child_group, parent_id))
            queue.append((child_id, child_group))

    log(f"  Custom groups found (under Company tree): {len(ordered)}")
    return ordered, by_id, parent_map


def get_group_name(gid, by_id):
    """Get a human-readable name for a group ID."""
    if gid == "GroupCompanyId":
        return "Company"
    g = by_id.get(gid)
    if g:
        return g.get("name", str(gid))
    return str(gid)


def copy_groups(source_api, target_api, test_group_id=None):
    """Copy custom groups from source to target database."""
    log("\nFetching groups from source database...")
    ordered, source_by_id, parent_map = fetch_group_tree(source_api)

    if not ordered:
        log("No custom groups found to copy.")
        return

    # Test mode: filter to just the one requested group
    if test_group_id:
        raw = source_by_id.get(test_group_id)
        if raw:
            log(f"\n  --- Raw API data for group {test_group_id} ---")
            log(json.dumps(raw, indent=2, default=str))
            log(f"  ---")

        match = [(g, pid) for g, pid in ordered if g["id"] == test_group_id]
        if not match:
            if test_group_id in source_by_id:
                log(f"ERROR: Group ID '{test_group_id}' is a system group and cannot be copied.")
            else:
                log(f"ERROR: Group ID '{test_group_id}' not found in source database.")
            return
        ordered = match
        g, pid = match[0]
        parent_name = get_group_name(pid, source_by_id)
        log(f"\n  TEST MODE: copying only \"{g.get('name')}\" (under \"{parent_name}\")")

    # Mapping: source group ID -> target group ID
    id_map = {"GroupCompanyId": "GroupCompanyId"}

    created = 0
    skipped = 0
    failed = 0

    total = len(ordered)
    batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    log(f"\nCreating {total} groups in target database ({batches} batch(es) of {BATCH_SIZE})...\n")

    api_calls = 0

    for i, (g, parent_id) in enumerate(ordered):
        # Pause between batches
        if api_calls > 0 and api_calls % BATCH_SIZE == 0:
            batch_num = api_calls // BATCH_SIZE
            log(f"\n  --- Batch {batch_num}/{batches} complete. Pausing {BATCH_PAUSE}s for rate limit... ---\n")
            time.sleep(BATCH_PAUSE)
        source_id = g["id"]
        name = g.get("name", "")
        target_parent_id = id_map.get(parent_id, parent_id)
        parent_name = get_group_name(parent_id, source_by_id)

        entity = {
            "name": name,
            "parent": {"id": target_parent_id},
        }
        for prop in ("comments", "color", "reference"):
            val = g.get(prop)
            if val:
                entity[prop] = val

        log(f"  Sending Add request: {json.dumps(entity, default=str)}")

        try:
            result = target_api.call("Add", type_name="Group", entity=entity)
            new_id = result
            id_map[source_id] = new_id
            created += 1
            api_calls += 1
            log(f"  [{i+1}/{total}] Created: \"{name}\" (under \"{parent_name}\") -> new ID: {new_id}")
        except mygeotab.MyGeotabException as e:
            err = str(e)
            if "DuplicateException" in err or "already exists" in err.lower():
                skipped += 1
                api_calls += 1
                log(f"  [{i+1}/{total}] Skipped (duplicate): \"{name}\" (under \"{parent_name}\")")
                try:
                    existing = target_api.call(
                        "Get",
                        type_name="Group",
                        search={"name": name, "parentGroupFilterId": target_parent_id},
                    )
                    if existing:
                        id_map[source_id] = existing[0]["id"]
                except Exception:
                    pass
            else:
                failed += 1
                api_calls += 1
                log(f"  [{i+1}/{total}] FAILED: \"{name}\" — {e}")
        except Exception as e:
            failed += 1
            api_calls += 1
            log(f"  [{i+1}/{total}] FAILED: \"{name}\" — {e}")

    log(f"\n--- Summary ---")
    log(f"  Created: {created}")
    log(f"  Skipped (duplicates): {skipped}")
    log(f"  Failed: {failed}")
    log(f"  Total processed: {created + skipped + failed}")


def main():
    global LOG_FILE

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = os.path.expanduser(f"~/Downloads/group_copy_{timestamp}.log")
    LOG_FILE = open(log_path, "w")

    log("=== MyGeotab Group Tree Copy ===")
    log(f"Log file: {log_path}")

    # Credentials
    username = input("Username (email): ").strip()
    password = getpass.getpass("Password: ")

    # Source
    source_db = input("\nSource database name: ").strip()
    try:
        log(f"Authenticating to source database ({source_db})...")
        source_api = authenticate("my.geotab.com", source_db, username, password)
        log("  Authenticated successfully.")
    except Exception as e:
        log(f"ERROR: Failed to authenticate to source database: {e}")
        sys.exit(1)

    # Test mode prompt
    test_group_id = None
    mode = input("\nMode — copy ALL groups or TEST with a single group? (all/test) [all]: ").strip().lower()
    if mode == "test":
        test_group_id = input("Enter the source group ID to copy: ").strip()
        if not test_group_id:
            log("ERROR: No group ID provided.")
            sys.exit(1)
        log(f"Test mode: group ID = {test_group_id}")

    # Target
    target_db = input("\nTarget database name: ").strip()
    try:
        log(f"Authenticating to target database ({target_db})...")
        target_api = authenticate("my.geotab.com", target_db, username, password)
        log("  Authenticated successfully.")
    except Exception as e:
        log(f"ERROR: Failed to authenticate to target database: {e}")
        sys.exit(1)

    copy_groups(source_api, target_api, test_group_id=test_group_id)

    log(f"\nLog saved to: {log_path}")
    LOG_FILE.close()


if __name__ == "__main__":
    main()
