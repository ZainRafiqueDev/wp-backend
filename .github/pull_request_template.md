## Summary

<!-- What changed and why. -->

## Cross-tenant isolation (WP-1.7)

CI fails `tests/unit/crossTenantRoutePack.test.ts` if a new `:chatbotId` route is mounted without a catalog entry **and** a `CROSS_TENANT:` covering marker.

- [ ] I inventoried every new or changed chatbot-scoped route (`/:chatbotId` on `/chatbots`, `/billing`, `/public`, or `/webhooks`).
- [ ] Each new chatbot-scoped route is listed in `tests/helpers/crossTenantRoutePack.ts`.
- [ ] Each new chatbot-scoped route has an “other tenant 404” (or documented public/webhook isolation) case.
- [ ] Documents, chunks SQL, actions, usage, conversations, and webhooks still have a negative cross-tenant case.

## Test plan

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
