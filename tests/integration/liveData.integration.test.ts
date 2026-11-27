import request from "supertest"
import { describe, expect, it } from "vitest"

import { app, signupUser } from "../helpers.js"

function authed(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function createChatbot(label: string) {
  const { session } = await signupUser(label)
  const created = await request(app)
    .post("/chatbots")
    .set(authed(session.access_token))
    .send({ name: `${label} bot`, sources: [{ type: "pdf", label: "a.pdf", characters: 5, content: "x" }] })
  return { session, chatbotId: created.body.chatbot.id as string }
}

describe("live-data CRUD (Task 2)", () => {
  it("requires authentication", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000"
    expect((await request(app).get(`/chatbots/${fakeId}/live-data`)).status).toBe(401)
    expect((await request(app).post(`/chatbots/${fakeId}/live-data`).send({ key: "k", value: "v" })).status).toBe(401)
  })

  it("creates, lists, updates, and deletes an entry for the caller's own chatbot", async () => {
    const { session, chatbotId } = await createChatbot("livedata-crud")

    const created = await request(app)
      .post(`/chatbots/${chatbotId}/live-data`)
      .set(authed(session.access_token))
      .send({ key: "Widget X stock", value: "42 in stock" })
    expect(created.status).toBe(201)
    expect(created.body.entry).toMatchObject({ key: "Widget X stock", value: "42 in stock" })
    const id = created.body.entry.id

    const listed = await request(app).get(`/chatbots/${chatbotId}/live-data`).set(authed(session.access_token))
    expect(listed.status).toBe(200)
    expect(listed.body.entries).toHaveLength(1)

    const updated = await request(app)
      .patch(`/chatbots/${chatbotId}/live-data/${id}`)
      .set(authed(session.access_token))
      .send({ value: "0 in stock" })
    expect(updated.status).toBe(200)
    expect(updated.body.entry.value).toBe("0 in stock")

    const removed = await request(app).delete(`/chatbots/${chatbotId}/live-data/${id}`).set(authed(session.access_token))
    expect(removed.status).toBe(204)

    const afterDelete = await request(app).get(`/chatbots/${chatbotId}/live-data`).set(authed(session.access_token))
    expect(afterDelete.body.entries).toHaveLength(0)
  })

  it("rejects a duplicate key for the same chatbot with 409", async () => {
    const { session, chatbotId } = await createChatbot("livedata-dup")
    await request(app).post(`/chatbots/${chatbotId}/live-data`).set(authed(session.access_token)).send({ key: "Stock", value: "10" })
    const dup = await request(app)
      .post(`/chatbots/${chatbotId}/live-data`)
      .set(authed(session.access_token))
      .send({ key: "Stock", value: "20" })
    expect(dup.status).toBe(409)
  })

  it("never lets one user read, update, or delete another user's chatbot or live-data row", async () => {
    const owner = await createChatbot("livedata-owner")
    const attacker = await createChatbot("livedata-attacker")

    const created = await request(app)
      .post(`/chatbots/${owner.chatbotId}/live-data`)
      .set(authed(owner.session.access_token))
      .send({ key: "Secret stock", value: "999" })
    const victimEntryId = created.body.entry.id

    // The attacker has their own chatbot (a valid, real chatbot_id
    // server-side), but neither the owner's chatbotId nor the owner's
    // entry id is ever honored from a request the attacker's own token
    // doesn't actually own — exactly the ownership check
    // services/liveData.service.ts and lib/chatbotOwnership.ts are
    // supposed to enforce.
    const readAttempt = await request(app).get(`/chatbots/${owner.chatbotId}/live-data`).set(authed(attacker.session.access_token))
    expect(readAttempt.status).toBe(404) // the chatbotId itself isn't the attacker's

    const updateAttempt = await request(app)
      .patch(`/chatbots/${attacker.chatbotId}/live-data/${victimEntryId}`)
      .set(authed(attacker.session.access_token))
      .send({ value: "0" })
    expect(updateAttempt.status).toBe(404) // right chatbot (theirs), wrong entry id — still not found

    const deleteAttempt = await request(app)
      .delete(`/chatbots/${attacker.chatbotId}/live-data/${victimEntryId}`)
      .set(authed(attacker.session.access_token))
    expect(deleteAttempt.status).toBe(404)

    // The owner's row is still there, untouched by the attacker's attempts.
    const ownerListing = await request(app).get(`/chatbots/${owner.chatbotId}/live-data`).set(authed(owner.session.access_token))
    expect(ownerListing.body.entries).toHaveLength(1)
    expect(ownerListing.body.entries[0].value).toBe("999")
  })

  it("rejects a non-uuid id with 400, not a 500", async () => {
    const { session, chatbotId } = await createChatbot("livedata-badid")
    const res = await request(app)
      .patch(`/chatbots/${chatbotId}/live-data/not-a-uuid`)
      .set(authed(session.access_token))
      .send({ value: "x" })
    expect(res.status).toBe(400)
  })
})
