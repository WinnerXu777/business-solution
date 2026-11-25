"""Run the versioned win-back fixture through the shared approval seam."""

from ..chat.gateway import Gateway


def run_win_back(
    gateway: Gateway, envelope: dict, mode: str, approval_id: str | None = None,
) -> dict:
    if mode == "preview" and approval_id is not None:
        raise ValueError("Preview does not take an approval")
    return gateway("workflow.template.run", envelope, {
        "templateId": "win-back-v1", "mode": mode, "approvalId": approval_id,
    })
