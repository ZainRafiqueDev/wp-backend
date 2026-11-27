# Booking/appointment demo (Phase E)

A real, minimal appointment-booking API demonstrating ChatMate360's Full
Custom tier's Custom Actions tool-calling — **not** the read-only backend-link
contract (`docs/BACKEND_INTEGRATION_CONTRACT.md`), because booking is
inherently conversational/multi-turn (check availability, then confirm a
specific slot with the customer's details), which only Custom Actions'
tool-calling supports.

## What's here

- `src/store.ts` — in-memory booking storage (services, slots, bookings).
  Swap this module for a real database in a production deployment; nothing
  else needs to change.
- `src/app.ts` — the Express API: `GET /health`, `GET /services`,
  `GET /availability`, `POST /bookings`, `GET /bookings/:id`.
- `src/index.ts` — starts the server (`PORT` env var, default 4100; optional
  `API_KEY` env var to require a bearer token on every route except
  `/health`, matching how a Custom Action sends the chatbot integration's
  API key).
- `custom-actions.ts` — the exact Custom Action definitions to register
  against a real ChatMate360 account (see below).
- `tests/booking.test.ts` — the API's own correctness tests (9 tests: slot
  math, double-booking rejection, validation, auth).
- `tests/customActionContract.test.ts` — proves the exact request shapes
  `custom-actions.ts` documents (what the AI's tool call actually sends) are
  accepted by this real API, i.e. the contract and the implementation agree.

Run it locally:

```
npm install
npm run dev        # http://localhost:4100
npm test           # 12/12 passing
```

## Wiring it into a real chatbot

1. Deploy this app somewhere it gets a real HTTPS URL (see **Deployment**
   below) — ChatMate360's `assertSafeUrl` SSRF check rejects
   localhost/private-IP targets by design, so a Custom Action can only ever
   call a real, publicly-reachable host, deliberately including in this demo.
2. On a **Full Custom** plan chatbot (Custom Actions are gated to that tier —
   see Phase E of `IMPLEMENTATION_STATUS.md`), register the two actions in
   `custom-actions.ts`, with `urlTemplate` set to your real deployed URL
   (`API_BASE_URL` in that file) plus the path shown, e.g.:

   ```
   POST /chatbots/<chatbotId>/actions
   Authorization: Bearer <your ChatMate360 access token>
   Content-Type: application/json

   {
     "name": "check_appointment_availability",
     "description": "Look up open appointment slots for a given service and date. Call this before offering the customer a time, and before create_booking.",
     "httpMethod": "GET",
     "urlTemplate": "https://your-booking-api.example.com/availability?serviceId={{service_id}}&date={{date}}",
     "headersTemplate": {},
     "bodyTemplate": null,
     "parameters": [
       { "name": "service_id", "type": "string", "description": "The service id, e.g. \"consult-30\", \"haircut-45\", or \"deep-clean-60\".", "required": true },
       { "name": "date", "type": "string", "description": "The date to check, in YYYY-MM-DD format.", "required": true }
     ]
   }
   ```

   and the equivalent for `create_booking` (see `custom-actions.ts` for the
   full body).

3. If you deployed with `API_KEY` set, connect that same key as this
   chatbot's backend-link integration (`PUT /chatbots/<chatbotId>/integration`
   with `{"apiKey": "<your API_KEY>"}`) — `executeAction` automatically sends
   it as `Authorization: Bearer <apiKey>` on every action call unless the
   action's own `headersTemplate` sets `Authorization` itself (neither of
   these two actions does).
4. Ask the chatbot something like "Can I book a haircut tomorrow at 2pm?" —
   the model should call `check_appointment_availability`, then
   `create_booking` once it has a name and email.

## Known limitation carried over from the Custom Actions engine

`actionExecutor.ts`'s `{{param}}` template filling leaves an unresolved
`{{param}}` literal in the request body when an *optional* parameter isn't
supplied by the model (rather than omitting the field) — this is a
pre-existing property of the templating engine, not something specific to
this demo. `custom-actions.ts` sidesteps it by making every parameter on
both actions required, so it can't occur here; an action with genuinely
optional fields (e.g. booking notes) would need that engine limitation
addressed first.

## Deployment (not done in this environment)

This sandbox has no cloud hosting credentials and can't provision public
infrastructure, so this API is not deployed to a real public URL as part of
this work — it's built and fully tested locally (12/12 tests passing) and
ready to deploy as-is. To actually deploy it:

- Any Node 20+ host works (Render, Railway, Fly.io, a VPS). Typical steps:
  `npm install && npm run build` (none needed — `tsx` runs the TS directly)
  then `npm start`, with `PORT` supplied by the host and `API_KEY` set to a
  secret you generate.
- Point `custom-actions.ts`'s `API_BASE_URL` (and the `urlTemplate` values
  you actually register) at that host's URL.
