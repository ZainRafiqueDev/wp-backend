import "express-serve-static-core"

declare module "express-serve-static-core" {
  interface Request {
    id: string
    adminUserId?: string
    /** SA-01: set by requireAdminAuth from admin_users.role on every request. */
    adminRole?: "super_admin" | "admin"
  }
}
