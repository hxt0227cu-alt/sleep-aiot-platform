CREATE TABLE "algorithm_proposals" (
    "algorithm_proposal_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_run_id" TEXT NOT NULL,
    "proposer_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "workflow_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "cohort_criteria" JSONB NOT NULL,
    "parameter_diff" JSONB NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "primary_metric" TEXT NOT NULL,
    "guardrail_metrics" JSONB NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "canary_percentage" INTEGER NOT NULL DEFAULT 5,
    "rollback_condition" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "canary_started_at" TIMESTAMPTZ,
    "activated_at" TIMESTAMPTZ,
    "rolled_back_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "algorithm_proposals_pkey" PRIMARY KEY ("algorithm_proposal_id")
);

CREATE TABLE "algorithm_proposal_actions" (
    "algorithm_proposal_action_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "algorithm_proposal_actions_pkey" PRIMARY KEY ("algorithm_proposal_action_id")
);

CREATE UNIQUE INDEX "algorithm_proposals_agent_run_id_key" ON "algorithm_proposals"("agent_run_id");
CREATE INDEX "algorithm_proposals_tenant_id_status_updated_at_idx" ON "algorithm_proposals"("tenant_id", "status", "updated_at");
CREATE INDEX "algorithm_proposals_proposer_id_created_at_idx" ON "algorithm_proposals"("proposer_id", "created_at");
CREATE INDEX "algorithm_proposal_actions_proposal_id_created_at_idx" ON "algorithm_proposal_actions"("proposal_id", "created_at");
CREATE INDEX "algorithm_proposal_actions_tenant_id_created_at_idx" ON "algorithm_proposal_actions"("tenant_id", "created_at");

ALTER TABLE "algorithm_proposals" ADD CONSTRAINT "algorithm_proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "algorithm_proposals" ADD CONSTRAINT "algorithm_proposals_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "algorithm_proposal_actions" ADD CONSTRAINT "algorithm_proposal_actions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "algorithm_proposals"("algorithm_proposal_id") ON DELETE CASCADE ON UPDATE CASCADE;
