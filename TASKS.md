# Build Tasks

## Done

- [x] Parent auth + order ownership enforcement:
  - protect `POST /orders/:orderId/retry`
  - protect `POST /orders/:orderId/gift-link`
  - protect `GET /orders/:orderId/status`
  - issue signed parent access token from `/users/upsert` and `/gift/redeem/:token`

## Backlog

- [ ] Add GitHub Actions CI pipeline:
  - run `npm ci`
  - run `npm run typecheck`
  - run `npm run smoke` with Postgres + Redis service containers and stub payment/email mode
  - enforce as required check via branch protection on `main`

- [ ] Payment/render reliability hardening:
  - idempotency keys for payment + queue enqueue
  - webhook replay protection + dedupe persistence
  - dead-letter/retry observability for failed jobs

- [ ] Parent experience polish:
  - resend gift email action
  - revoke/regenerate gift link UX
  - clearer unauthorized/session-expired recovery path

- [ ] Support/admin visibility:
  - admin page for `email_notifications` failures
  - retry history view from `order_retry_requests`
  - provider task failure triage view
