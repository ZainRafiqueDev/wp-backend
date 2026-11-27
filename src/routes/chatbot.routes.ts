import { Router } from "express"

import { getActions, postAction, putAction, removeAction } from "../controllers/actions.controller.js"
import { getDocuments, getDocumentIngestStatus, postDocument, removeDocument, retryFailedDocument } from "../controllers/documents.controller.js"
import {
  chatWithChatbot,
  createFirstChatbot,
  getChatbots,
  getStatus,
  retryChatbot,
  setDomain,
  setFallbackMessage,
  setPreferredModel,
  setTheme,
  getUsageSummary,
  getAnalyticsSummary,
} from "../controllers/chatbot.controller.js"
import { getIntegration, putIntegration, removeIntegration } from "../controllers/integration.controller.js"
import { deleteWooCommerceConnection, getWooCommerceStatus, postWooCommerceConnect, postWooCommerceSync } from "../controllers/commerceWooCommerce.controller.js"
import {
  deleteBooklyConnection,
  getBooklyMeetingHistoryReport,
  getBooklyStatus,
  postBooklyConnect,
} from "../controllers/booklyCredentials.controller.js"
import { getBooklyAdminAuditLog, postBooklyAdminChat } from "../controllers/booklyAdminChat.controller.js"
import { getLiveData, patchLiveData, postLiveData, removeLiveData } from "../controllers/liveData.controller.js"
import { getAttachmentDownload, getAttachments } from "../controllers/chatAttachments.controller.js"
import {
  deleteOkfConcept,
  getOkfAudit,
  getOkfConcept,
  getOkfConcepts,
  getOkfExport,
  getOkfIndex,
  getOkfOverview,
  postApproveOkfConcept,
  postOkfConcept,
  postRestoreOkfConcept,
  putOkfConcept,
} from "../controllers/okf.controller.js"
import { rateLimitAuthenticatedChat } from "../middleware/rateLimitAuthenticatedChat.js"
import { requireAuth } from "../middleware/requireAuth.js"
import { requireDb } from "../middleware/requireDb.js"
import { uploadDocument } from "../middleware/uploadDocument.js"
import { validateBody, validateParams } from "../middleware/validate.js"
import { actionIdParamSchema, createActionSchema, updateActionSchema } from "../validators/actions.validator.js"
import { documentIdParamSchema } from "../validators/documents.validator.js"
import { attachmentIdParamSchema } from "../validators/chatAttachments.validator.js"
import {
  chatSchema,
  chatbotIdParamSchema,
  createChatbotSchema,
  retryChatbotSchema,
  updateDomainSchema,
  updateFallbackMessageSchema,
  updatePreferredModelSchema,
  updateThemeSchema,
} from "../validators/chatbot.validator.js"
import { upsertIntegrationSchema } from "../validators/integration.validator.js"
import { createLiveDataSchema, liveDataIdParamSchema, updateLiveDataSchema } from "../validators/liveData.validator.js"
import { connectWooCommerceSchema } from "../validators/commerceWooCommerce.validator.js"
import { connectBooklySchema } from "../validators/booklyCredentials.validator.js"
import { booklyAdminChatSchema } from "../validators/booklyAdminChat.validator.js"
import {
  createOkfConceptSchema,
  okfAuditRestoreSchema,
  okfConceptParamSchema,
  updateOkfConceptSchema,
} from "../validators/okf.validator.js"


export const chatbotRouter = Router()

chatbotRouter.get("/", requireAuth, requireDb, getChatbots)
chatbotRouter.post("/", requireAuth, requireDb, validateBody(createChatbotSchema), createFirstChatbot)
chatbotRouter.get("/:chatbotId", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getStatus)
chatbotRouter.post(
  "/:chatbotId/retry",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(retryChatbotSchema),
  retryChatbot,
)
chatbotRouter.patch(
  "/:chatbotId/theme",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(updateThemeSchema),
  setTheme,
)
chatbotRouter.patch(
  "/:chatbotId/domain",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(updateDomainSchema),
  setDomain,
)
chatbotRouter.patch(
  "/:chatbotId/fallback-message",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(updateFallbackMessageSchema),
  setFallbackMessage,
)

chatbotRouter.patch(
  "/:chatbotId/preferred-model",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(updatePreferredModelSchema),
  setPreferredModel,
)
//dfkljhgtongygrnrubg gtugbr gworker of the thread to the required model but silently kepth under the pressure by him



chatbotRouter.get("/:chatbotId/usage", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getUsageSummary)
chatbotRouter.get("/:chatbotId/analytics", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getAnalyticsSummary)

chatbotRouter.post(
  "/:chatbotId/chat",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  rateLimitAuthenticatedChat,
  validateBody(chatSchema),
  chatWithChatbot,
)


chatbotRouter.get("/:chatbotId/live-data", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getLiveData)
chatbotRouter.post(
  "/:chatbotId/live-data",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(createLiveDataSchema),
  postLiveData,
)
chatbotRouter.patch(
  "/:chatbotId/live-data/:id",
  requireAuth,
  requireDb,
  validateParams(liveDataIdParamSchema),
  validateBody(updateLiveDataSchema),
  patchLiveData,
)
chatbotRouter.delete(
  "/:chatbotId/live-data/:id",
  requireAuth,
  requireDb,
  validateParams(liveDataIdParamSchema),
  removeLiveData,
)



chatbotRouter.get("/:chatbotId/integration", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getIntegration)
chatbotRouter.put(
  "/:chatbotId/integration",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(upsertIntegrationSchema),
  putIntegration,
)
chatbotRouter.delete(
  "/:chatbotId/integration",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  removeIntegration,
)


chatbotRouter.get("/:chatbotId/actions", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getActions)
chatbotRouter.post(
  "/:chatbotId/actions",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(createActionSchema),
  postAction,
)
chatbotRouter.put(
  "/:chatbotId/actions/:id",
  requireAuth,
  requireDb,
  validateParams(actionIdParamSchema),
  validateBody(updateActionSchema),
  putAction,
)
chatbotRouter.delete(
  "/:chatbotId/actions/:id",
  requireAuth,
  requireDb,
  validateParams(actionIdParamSchema),
  removeAction,
)


chatbotRouter.get("/:chatbotId/documents", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getDocuments)
chatbotRouter.get(
  "/:chatbotId/documents/:id/status",
  requireAuth,
  requireDb,
  validateParams(documentIdParamSchema),
  getDocumentIngestStatus,
)
chatbotRouter.post(
  "/:chatbotId/documents",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  uploadDocument,
  postDocument,
)
chatbotRouter.delete(
  "/:chatbotId/documents/:id",
  requireAuth,
  requireDb,
  validateParams(documentIdParamSchema),
  removeDocument,
)
chatbotRouter.post(
  "/:chatbotId/documents/:id/retry",
  requireAuth,
  requireDb,
  validateParams(documentIdParamSchema),
  retryFailedDocument,
)

// Phase 3 (2026-10-27): managed chat attachments — both Viewer+ (read-only
// dashboard surface, matching the Phase 2 route-trace table's pattern for
// every other list/download route).
chatbotRouter.get("/:chatbotId/attachments", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getAttachments)
chatbotRouter.get(
  "/:chatbotId/attachments/:attachmentId",
  requireAuth,
  requireDb,
  validateParams(attachmentIdParamSchema),
  getAttachmentDownload,
)

chatbotRouter.get("/:chatbotId/okf/overview", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getOkfOverview)
chatbotRouter.get("/:chatbotId/okf/index", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getOkfIndex)
chatbotRouter.get("/:chatbotId/okf/export", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getOkfExport)
chatbotRouter.get("/:chatbotId/okf/concepts", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getOkfConcepts)
chatbotRouter.post(
  "/:chatbotId/okf/concepts",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(createOkfConceptSchema),
  postOkfConcept,
)
chatbotRouter.get(
  "/:chatbotId/okf/concepts/:id",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  getOkfConcept,
)
chatbotRouter.put(
  "/:chatbotId/okf/concepts/:id",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  validateBody(updateOkfConceptSchema),
  putOkfConcept,
)
chatbotRouter.post(
  "/:chatbotId/okf/concepts/:id/approve",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  postApproveOkfConcept,
)
chatbotRouter.delete(
  "/:chatbotId/okf/concepts/:id",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  deleteOkfConcept,
)
chatbotRouter.get(
  "/:chatbotId/okf/concepts/:id/audit",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  getOkfAudit,
)
chatbotRouter.post(
  "/:chatbotId/okf/concepts/:id/restore",
  requireAuth,
  requireDb,
  validateParams(okfConceptParamSchema),
  validateBody(okfAuditRestoreSchema),
  postRestoreOkfConcept,
)


chatbotRouter.get("/:chatbotId/woocommerce", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getWooCommerceStatus)
chatbotRouter.post(
  "/:chatbotId/woocommerce",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(connectWooCommerceSchema),
  postWooCommerceConnect,
)
chatbotRouter.delete("/:chatbotId/woocommerce", requireAuth, requireDb, validateParams(chatbotIdParamSchema), deleteWooCommerceConnection)
chatbotRouter.post("/:chatbotId/woocommerce/sync", requireAuth, requireDb, validateParams(chatbotIdParamSchema), postWooCommerceSync)


chatbotRouter.get("/:chatbotId/bookly", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getBooklyStatus)
chatbotRouter.post(
  "/:chatbotId/bookly",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(connectBooklySchema),
  postBooklyConnect,
)
chatbotRouter.delete("/:chatbotId/bookly", requireAuth, requireDb, validateParams(chatbotIdParamSchema), deleteBooklyConnection)

chatbotRouter.get(
  "/:chatbotId/bookly/meeting-history",
  requireAuth,
  requireDb,
  validateParams(chatbotIdParamSchema),
  getBooklyMeetingHistoryReport,
)


chatbotRouter.post(
  "/:chatbotId/bookly-admin-chat",
  requireDb,
  validateParams(chatbotIdParamSchema),
  validateBody(booklyAdminChatSchema),
  postBooklyAdminChat,
)

chatbotRouter.get("/:chatbotId/bookly-admin-audit-log", requireAuth, requireDb, validateParams(chatbotIdParamSchema), getBooklyAdminAuditLog)
