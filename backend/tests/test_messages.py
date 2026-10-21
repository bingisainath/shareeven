async def _history(client, user, conversation_id, **params):
    r = await client.get(f"/api/v1/conversations/{conversation_id}/messages", params=params, headers=user.headers)
    assert r.status_code == 200
    return r.json()


async def test_history_returns_newest_page_oldest_first(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    for i in range(7):
        await add_message(dm, a, f"m{i}")
    page = await _history(client, b, dm, limit=5)
    assert [m["text"] for m in page["data"]] == ["m2", "m3", "m4", "m5", "m6"]
    assert page["has_more"] is True
    older = await _history(client, b, dm, limit=5, before=page["data"][0]["id"])
    assert [m["text"] for m in older["data"]] == ["m0", "m1"]
    assert older["has_more"] is False


async def test_reply_preview_in_history(client, make_user, make_dm, add_message):
    import uuid
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    original = await add_message(dm, a, "original")
    await add_message(dm, b, "answer", reply_to_id=uuid.UUID(original))
    reply = (await _history(client, a, dm))["data"][-1]
    assert reply["reply_to"]["id"] == original
    assert reply["reply_to"]["text"] == "original"


async def test_edit_own_message(client, make_user, make_dm, add_message, events):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    msg = await add_message(dm, a, "e2e1:typo")
    # Edits are end-to-end encrypted like new messages: a readable one is refused and nothing changes
    r = await client.patch(f"/api/v1/messages/{msg}", json={"text": "fixed"}, headers=a.headers)
    assert r.status_code == 422 and "isn't end-to-end encrypted" in r.text
    assert (await _history(client, b, dm))["data"][-1]["text"] == "e2e1:typo"
    r = await client.patch(f"/api/v1/messages/{msg}", json={"text": "e2e1:fixed"}, headers=a.headers)
    assert r.status_code == 200
    edited = (await _history(client, b, dm))["data"][-1]
    assert edited["text"] == "e2e1:fixed" and edited["edited_at"]
    assert any(p["type"] == "message_updated" and p["text"] == "e2e1:fixed" for _, p in events)


async def test_cannot_edit_or_delete_others_messages(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    msg = await add_message(dm, a, "mine")
    assert (await client.patch(f"/api/v1/messages/{msg}", json={"text": "e2e1:x"}, headers=b.headers)).status_code == 403
    assert (await client.delete(f"/api/v1/messages/{msg}", headers=b.headers)).status_code == 403


async def test_outsider_cannot_touch_messages(client, make_user, make_dm, add_message):
    a, b, outsider = await make_user(), await make_user(), await make_user()
    msg = await add_message(await make_dm(a, b), a, "private")
    assert (await client.put(f"/api/v1/messages/{msg}/reaction", json={"emoji": "👍"}, headers=outsider.headers)).status_code == 404


async def test_delete_for_everyone(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    msg = await add_message(dm, a, "oops")
    assert (await client.delete(f"/api/v1/messages/{msg}", headers=a.headers)).status_code == 200
    deleted = (await _history(client, b, dm))["data"][-1]
    assert deleted["is_deleted"] is True and deleted["text"] == ""
    conv = [c for c in (await client.get("/api/v1/conversations", headers=b.headers)).json()["data"] if c["id"] == dm][0]
    assert conv["lastMessage"] == "This message was deleted"


async def test_reactions_toggle_and_replace(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    msg = await add_message(dm, a, "nice")

    async def react(user, emoji):
        r = await client.put(f"/api/v1/messages/{msg}/reaction", json={"emoji": emoji}, headers=user.headers)
        assert r.status_code == 200
        return r.json()["data"]["reactions"]

    assert await react(b, "👍") == [{"emoji": "👍", "userIds": [b.id]}]
    assert await react(b, "❤️") == [{"emoji": "❤️", "userIds": [b.id]}]  # one reaction per person
    assert await react(b, "❤️") == []  # same emoji again removes it


async def test_unsupported_reaction_rejected(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    msg = await add_message(await make_dm(a, b), a)
    r = await client.put(f"/api/v1/messages/{msg}/reaction", json={"emoji": "<script>"}, headers=b.headers)
    assert r.status_code == 400



async def test_ticks_sent_then_delivered(client, make_user, make_dm, add_message, events):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    await add_message(dm, a, "hi bob")
    assert (await _history(client, a, dm))["data"][-1]["status"] == "sent"  # not on Bob's devices yet

    # Bob's app loads its chat list: the message reached his phone
    assert (await client.get("/api/v1/conversations", headers=b.headers)).status_code == 200
    assert (await _history(client, a, dm))["data"][-1]["status"] == "delivered"

    # Loading the list again changes nothing and announces nothing new
    before = len([p for _, p in events if p["type"] == "delivered"])
    await client.get("/api/v1/conversations", headers=b.headers)
    assert len([p for _, p in events if p["type"] == "delivered"]) == before


async def test_delivered_receipt_over_websocket(client, make_user, make_dm, add_message):
    import uuid as _uuid
    import app.websocket.routes as ws_routes
    a, b, outsider = await make_user(), await make_user(), await make_user()
    dm = await make_dm(a, b)
    msg = await add_message(dm, a, "ping")

    # Someone outside the chat can't mark it
    await ws_routes._handle_delivered(_uuid.UUID(outsider.id), dm, msg)
    assert (await _history(client, a, dm))["data"][-1]["status"] == "sent"

    await ws_routes._handle_delivered(_uuid.UUID(b.id), dm, msg)
    assert (await _history(client, a, dm))["data"][-1]["status"] == "delivered"


async def test_delivered_event_tells_members(client, make_user, make_dm, add_message, events):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    await add_message(dm, b, "from bob")
    await _history(client, a, dm)  # Alice has Bob's message: her pointer is set
    await add_message(dm, a, "reply")
    await client.get("/api/v1/conversations", headers=b.headers)
    event = next(p for _, p in reversed(events) if p["type"] == "delivered" and p["roomId"] == dm)
    assert event["deliveredUpTo"]
