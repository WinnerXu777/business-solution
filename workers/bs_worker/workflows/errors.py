"""Command errors exposed by both workflow runners."""


class WorkflowConflict(ValueError):
    pass


class WorkflowQuota(WorkflowConflict):
    pass

