// CS-15 (B02-005, B03-016, S3-012): production DB credential/role guards.
import { describe, expect, it } from "vitest"

import {
  assertNoDefaultDatabasePassword,
  dbRoleProblems,
  defaultPasswordProblem,
  isFatalInProduction,
} from "../../src/lib/dbGuards.js"

const facts = (over: Partial<Parameters<typeof dbRoleProblems>[1]> = {}) => ({
  currentUser: "chatmate360_app",
  rolsuper: false,
  rolbypassrls: false,
  isSystemMember: false,
  ...over,
})

describe("CS-15 database guards", () => {
  it("flags the shipped default and self-named passwords without echoing them", () => {
    expect(defaultPasswordProblem("postgresql://chatmate360_app:chatmate360_app@db/x")).toMatch(/equals the role name/)
    expect(defaultPasswordProblem("postgresql://chatmate360_system:chatmate360_app@db/x")).toMatch(/well-known/)
    expect(defaultPasswordProblem("postgresql://postgres:postgres@db/x")).not.toContain("postgres:")
    expect(defaultPasswordProblem("postgresql://chatmate360_app:Zq8-unique-Secret@db/x")).toBeNull()
    expect(defaultPasswordProblem("postgresql://chatmate360_app@db/x")).toBeNull()
  })

  it("refuses a default password in production only", () => {
    const url = "postgresql://chatmate360_app:chatmate360_app@db/x"
    expect(() => assertNoDefaultDatabasePassword(url, "DATABASE_URL", "production")).toThrow(/DATABASE_URL/)
    expect(() => assertNoDefaultDatabasePassword(url, "DATABASE_URL", "test")).not.toThrow()
  })

  it("treats a bypass role as fatal on either pool (S3-012)", () => {
    const tenant = dbRoleProblems("tenant", facts({ rolbypassrls: true }), "chatmate360_app")
    expect(tenant.map((p) => p.event)).toContain("rls.bypass_role")
    expect(tenant.some(isFatalInProduction)).toBe(true)
    const system = dbRoleProblems("system", facts({ currentUser: "postgres", rolsuper: true, isSystemMember: true }), "chatmate360_app")
    expect(system.some(isFatalInProduction)).toBe(true)
  })

  it("treats a tenant role that can reach chatmate360_system as fatal (B02-009)", () => {
    const problems = dbRoleProblems("tenant", facts({ isSystemMember: true }), "chatmate360_app")
    expect(problems.map((p) => p.event)).toContain("rls.tenant_role_privileged")
    expect(problems.some(isFatalInProduction)).toBe(true)
  })

  it("accepts the intended roles", () => {
    expect(dbRoleProblems("tenant", facts(), "chatmate360_app")).toEqual([])
    expect(dbRoleProblems("system", facts({ currentUser: "chatmate360_system", isSystemMember: true }), "chatmate360_app")).toEqual([])
    const wrongSystem = dbRoleProblems("system", facts(), "chatmate360_app")
    expect(wrongSystem.map((p) => p.event)).toEqual(["rls.system_role_missing"])
  })
})
