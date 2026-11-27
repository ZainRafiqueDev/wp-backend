// This file used to be a single 1,118-line module mixing eight unrelated
// concerns (auth, user management, plan activation, usage reporting, abuse
// flags, notifications, routing activity, ops health) — flagged in the
// 2026-09-29 production-hardening audit as the clearest case in this repo
// for a feature-based split. It's now a thin re-export barrel over
// src/services/admin/*, so every existing `from "./services/admin.service.js"`
// import elsewhere in the codebase keeps working unchanged. New code should
// import directly from the specific src/services/admin/*.service.js module
// it needs rather than through this barrel.
export * from "./admin/adminAuth.service.js"
export * from "./admin/adminUsers.service.js"
export * from "./admin/adminPlans.service.js"
export * from "./admin/adminUsage.service.js"
export * from "./admin/adminAbuse.service.js"
export * from "./admin/adminNotifications.service.js"
export * from "./admin/adminRouting.service.js"
export * from "./admin/adminOps.service.js"
