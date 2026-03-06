# Build Tasks

## Next Up (Priority Order)

- [x] Resend gift email action (parent experience)
- [x] Revoke/regenerate gift link UX (parent experience)
- [ ] Unauthorized/session-expired recovery path (parent experience)
- [ ] Admin page for `email_notifications` failures
- [ ] Retry history view from `order_retry_requests`
- [ ] Provider task failure triage view

## Done

- [x] Resend gift email action (parent experience):
  - parent order page can resend the latest pending gift-link email
  - API reuses the latest valid gift link instead of generating a new one
  - resend attempts are logged in `email_notifications`
- [x] Revoke/regenerate gift link UX (parent experience):
  - parent order page can explicitly revoke the current pending gift link
  - gift link creation flow now doubles as an explicit regenerate action
  - latest gift-link status and expiry are visible in the parent order UI
- [x] Parent auth + order ownership enforcement:
  - protect `POST /orders/:orderId/retry`
  - protect `POST /orders/:orderId/gift-link`
  - protect `GET /orders/:orderId/status`
  - issue signed parent access token from `/users/upsert` and `/gift/redeem/:token`
- [x] Add GitHub Actions CI pipeline:
  - run `npm ci`
  - run `npm run typecheck`
  - run `npm run smoke` with Postgres + Redis service containers and stub payment/email mode
  - workflow is live; required check enforcement is blocked until GitHub billing lock is resolved
- [x] Payment/render reliability hardening:
  - idempotency keys for payment + queue enqueue
  - webhook replay protection + dedupe persistence
  - dead-letter/retry observability for failed jobs

## Backlog

- [ ] Parent experience polish:
  - resend gift email action
  - revoke/regenerate gift link UX
  - clearer unauthorized/session-expired recovery path

- [ ] Support/admin visibility:
  - admin page for `email_notifications` failures
  - retry history view from `order_retry_requests`
  - provider task failure triage view
