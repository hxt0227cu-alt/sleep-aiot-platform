import os


# Unit tests must never consume a developer's configured paid model quota.
os.environ["AGENT_MODEL_PROVIDER"] = "deterministic"
