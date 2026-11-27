import express from "express"
import cookieParser from "cookie-parser"
import request from "supertest"
import { describe, expect, it } from "vitest"

const { env } = await import("../../src/env.js")
const { requireTrustedOrigin } = await import("../../src/middleware/requireTrustedOrigin.js")

const app = express()
app.use(cookieParser())
app.use(requireTrustedOrigin)
app.all("/thing", (_req, res) => res.json({ ok: true }))

const frontend = new URL(env.frontendUrl).origin
const authCookie = "chatmate360_access_token=abc"

describe("requireTrustedOrigin (CSRF)", () => {
  it("refuses a cookie-authenticated POST from another site", async () => {
    const res = await request(app).post("/thing").set("Cookie", authCookie).set("Origin", "https://evil.example")
    expect(res.status).toBe(403)
  })

  it("refuses a cookie-authenticated POST with neither Origin nor Referer", async () => {
    const res = await request(app).post("/thing").set("Cookie", "chatmate360_refresh_token=abc")
    expect(res.status).toBe(403)
  })

  it("refuses a cookie-authenticated POST whose Referer is a lookalike of the frontend", async () => {
    const res = await request(app).post("/thing").set("Cookie", authCookie).set("Referer", `${frontend}.evil.example/x`)
    expect(res.status).toBe(403)
  })

  it("allows the frontend origin, by Origin or by Referer", async () => {
    expect((await request(app).post("/thing").set("Cookie", authCookie).set("Origin", frontend)).status).toBe(200)
    expect((await request(app).delete("/thing").set("Cookie", authCookie).set("Referer", `${frontend}/settings`)).status).toBe(200)
  })

  it("leaves safe methods and cookie-less requests (Bearer clients, widget, webhooks) alone", async () => {
    expect((await request(app).get("/thing").set("Cookie", authCookie).set("Origin", "https://evil.example")).status).toBe(200)
    expect((await request(app).post("/thing").set("Authorization", "Bearer abc").set("Origin", "https://evil.example")).status).toBe(200)
    expect((await request(app).post("/thing")).status).toBe(200)
  })
})
