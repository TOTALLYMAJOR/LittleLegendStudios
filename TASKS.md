# Build Tasks

## Next Up (Priority Order)

- [x] Resend gift email action (parent experience)
- [x] Revoke/regenerate gift link UX (parent experience)
- [x] Unauthorized/session-expired recovery path (parent experience)
- [x] Admin page for `email_notifications` failures
- [x] Retry history view from `order_retry_requests`
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
- [x] Unauthorized/session-expired recovery path (parent experience):
  - order page now links directly into a session recovery flow with return-to order context
  - create page can restore the parent session and send the parent back to the blocked order
  - in-page order actions surface session expiry and route the parent into recovery
- [x] Admin page for `email_notifications` failures:
  - API exposes a token-gated failed notification feed with summary counts and filters
  - web admin page loads recent failed notifications with payload/error inspection
  - home page now links into the admin failure view
- [x] Retry history view from `order_retry_requests`:
  - API exposes a token-gated retry request feed with actor/outcome filters
  - web admin page shows accepted and rejected retry requests with order context
  - home page now links into the retry history view
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

- [x] Parent experience polish:
  - resend gift email action
  - revoke/regenerate gift link UX
  - clearer unauthorized/session-expired recovery path

- [ ] Support/admin visibility:
  - done: admin page for `email_notifications` failures
  - done: retry history view from `order_retry_requests`
  - provider task failure triage view
