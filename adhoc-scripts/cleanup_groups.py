#!/usr/bin/env python3
"""Remove specific groups from a MyGeotab database using a file of group IDs.

Usage:
  python3 cleanup_groups.py <file_with_group_ids>

The file should have one group ID per line (blank lines and # comments are ignored).
Groups are deleted children-first to avoid parent dependency errors.
"""

import getpass
import sys
import time

import mygeotab

BATCH_SIZE = 350
BATCH_PAUSE = 61


def is_system_group_id(gid):
    return isinstance(gid, str) and gid.startswith("Group")


def load_ids(filepath):
    """Load group IDs from a text file, one per line."""
    ids = set()
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                ids.add(line)
    return ids


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 cleanup_groups.py <file_with_group_ids>")
        print("  File should contain one group ID per line.")
        sys.exit(1)

    id_file = sys.argv[1]
    target_ids = load_ids(id_file)
    if not target_ids:
        print(f"No group IDs found in {id_file}")
        sys.exit(1)

    print(f"=== MyGeotab Group Cleanup ===")
    print(f"Loaded {len(target_ids)} group IDs from {id_file}\n")

    username = input("Username (email): ").strip()
    password = getpass.getpass("Password: ")
    database = input("Database name: ").strip()

    try:
        print(f"Authenticating to {database}...")
        api = mygeotab.API(username=username, password=password, database=database, server="my.geotab.com")
        api.authenticate()
        print("  Authenticated successfully.")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print("\nFetching groups...")
    all_groups = api.call("Get", type_name="Group")
    by_id = {g["id"]: g for g in all_groups}

    # BFS from GroupCompanyId to get tree order
    company = by_id.get("GroupCompanyId")
    if not company:
        print("ERROR: GroupCompanyId not found.")
        sys.exit(1)

    ordered = []
    queue = [company]
    while queue:
        parent = queue.pop(0)
        for child_ref in parent.get("children", []):
            child_id = child_ref.get("id", "")
            if not child_id or is_system_group_id(child_id):
                continue
            child = by_id.get(child_id)
            if child:
                if child_id in target_ids:
                    ordered.append(child)
                queue.append(child)

    # Also catch any IDs from the file that weren't in the tree walk
    found_ids = {g["id"] for g in ordered}
    missing = target_ids - found_ids
    if missing:
        print(f"\n  WARNING: {len(missing)} IDs from file not found in database: {', '.join(list(missing)[:10])}{'...' if len(missing) > 10 else ''}")

    if not ordered:
        print("No matching groups found in database. Nothing to delete.")
        return

    # Reverse so children are deleted before parents
    ordered.reverse()

    print(f"\nFound {len(ordered)} groups to delete.")
    # Show first few
    for g in ordered[:5]:
        print(f"  - \"{g.get('name', '')}\" ({g['id']})")
    if len(ordered) > 5:
        print(f"  ... and {len(ordered) - 5} more")

    confirm = input("\nType 'DELETE' to confirm: ").strip()
    if confirm != "DELETE":
        print("Aborted.")
        return

    deleted = 0
    failed = 0
    total = len(ordered)

    print()
    for i, g in enumerate(ordered):
        if i > 0 and i % BATCH_SIZE == 0:
            batch_num = i // BATCH_SIZE
            print(f"\n  --- Batch {batch_num} complete. Pausing {BATCH_PAUSE}s for rate limit... ---\n")
            time.sleep(BATCH_PAUSE)

        name = g.get("name", "")
        gid = g["id"]
        try:
            api.call("Remove", type_name="Group", entity={"id": gid})
            deleted += 1
            print(f"  [{i+1}/{total}] Deleted: \"{name}\" ({gid})")
        except Exception as e:
            failed += 1
            print(f"  [{i+1}/{total}] FAILED: \"{name}\" ({gid}) — {e}")

    print(f"\n--- Summary ---")
    print(f"  Deleted: {deleted}")
    print(f"  Failed: {failed}")


if __name__ == "__main__":
    main()
