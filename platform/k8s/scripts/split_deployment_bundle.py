import argparse
from pathlib import Path

import yaml


PREREQUISITE_KINDS = {
    "Namespace",
    "ServiceAccount",
    "ConfigMap",
    "PersistentVolumeClaim",
    "Service",
    "NetworkPolicy",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    documents = [item for item in yaml.safe_load_all(args.input.read_text(encoding="utf-8")) if item]
    groups = {
        "prerequisites.yaml": [item for item in documents if item.get("kind") in PREREQUISITE_KINDS],
        "migration.yaml": [item for item in documents if item.get("kind") == "Job"],
        "workloads.yaml": [item for item in documents if item.get("kind") not in PREREQUISITE_KINDS | {"Job"}],
    }
    if not groups["migration.yaml"]:
        raise SystemExit("Deployment bundle has no migration Job")
    if not any(item.get("kind") == "Deployment" for item in groups["workloads.yaml"]):
        raise SystemExit("Deployment bundle has no workloads")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, items in groups.items():
        (args.output_dir / filename).write_text(
            yaml.safe_dump_all(items, sort_keys=False), encoding="utf-8"
        )


if __name__ == "__main__":
    main()
