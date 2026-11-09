-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "routing_key" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "published_at" TIMESTAMPTZ,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_next_attempt_at_idx" ON "outbox_events"("published_at", "next_attempt_at");
